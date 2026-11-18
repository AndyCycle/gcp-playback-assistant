importScripts("routes.js");

const OPEN_TIMEOUT = 30_000;
const OTHER_PLAYER = "检测到另一门课程的播放页。关闭它后，点「继续自动化」。";
let queue = Promise.resolve();

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.frameId !== 0 || !sender.tab || !message?.action) return;
  const job = queue.then(() => handle(message, sender.tab));
  queue = job.catch(() => {});
  job.then(reply, (error) => {
    console.error(error);
    reply({ status: "控件操作失败，请刷新后重试。" });
  });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId, { isWindowClosing }) => {
  queue = queue.then(async () => {
    const { run } = await chrome.storage.session.get("run");
    if (tabId !== run?.assessmentTabId) return;
    await save({ ...run, assessmentTabId: null });
    if (!isWindowClosing) await chrome.tabs.reload(run.classId);
  }).catch(console.error);
});

async function save(run, extra = {}) {
  await chrome.storage.session.set({ run });
  return { run, ...extra };
}

function readAssessmentLink(attribute, token) {
  const entry = document.querySelector(`[${attribute}="${CSS.escape(token)}"]`);
  if (!entry || entry.textContent.replace(/\s+/g, "") !== "我要评估") return null;

  // The site's click handler passes its assessment link to window.open synchronously.
  let link = null;
  const open = window.open;
  window.open = (href, target) => {
    if (target === "_bank") link = href;
    return null;
  };
  try {
    entry.click();
  } finally {
    window.open = open;
  }
  return link;
}

async function openAssessment(run, tab, message) {
  const next = { ...run, assessmentAttempted: message.course };
  await save(next);
  const [{ result: link }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: readAssessmentLink,
    args: [ASSESSMENT_ENTRY, message.token]
  });
  if (!link) return { run: next };

  const url = new URL(link, tab.url);
  if (!isCourseAssessment(url.href)) return { run: next };
  const assessment = await chrome.tabs.create({ url: url.href, windowId: tab.windowId, openerTabId: tab.id });
  return save({ ...next, assessmentTabId: assessment.id, assessmentUrl: url.href },
    { status: "已打开课程评估，正在按第一项填写。" });
}

function prepareAssessmentPage() {
  // Browser-created tabs lack a DOM opener. The extension refreshes the course list on tab close.
  if (window.opener === null) window.opener = { postMessage() {} };
}

async function handleAssessment(message, tab, run) {
  if (!run || run.assessmentUrl !== tab.url) return {};
  if (run.assessmentTabId !== tab.id) {
    if (run.assessmentTabId || tab.openerTabId !== run.classId) return {};
    run = { ...run, assessmentTabId: tab.id };
    await save(run);
  }
  if (message.action === "pause") return save({ ...run, paused: "自动化已暂停。" });
  if (message.action === "resume") return save({ ...run, paused: "" });
  if (message.action === "prepareAssessment") {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: prepareAssessmentPage
    });
  }
  return { run };
}

async function handle(message, tab) {
  const kind = pageKind(tab.url);
  const survey = isCourseAssessment(tab.url);
  if (!survey && kind !== "class" && !isPlayer(kind)) return {};

  let { run } = await chrome.storage.session.get("run");
  if (survey) return handleAssessment(message, tab, run);
  if (!run && message.action !== "start") return {};

  const tabs = await chrome.tabs.query({ url: SITE_HOSTS });
  const hasClass = run && tabs.some((item) =>
    item.id === run.classId && [item.url, item.pendingUrl].some((url) => pageKind(url))
  );
  if (run && !hasClass) {
    await chrome.storage.session.remove("run");
    run = undefined;
  }
  const inClass = kind === "class" && tab.id === run?.classId;
  const inPlayer = isPlayer(kind) && tab.id === run?.playerId;
  const belongsToClass = run && (tab.id === run.classId || tab.openerTabId === run.classId);
  const boundPlayer = isPlayer(kind) && belongsToClass && (inPlayer || run.phase === "opening");
  const conflicting = tabs.some((item) =>
    !(boundPlayer && item.id === tab.id) &&
    item.id !== run?.playerId &&
    [item.url, item.pendingUrl].some((url) => isPlayer(pageKind(url)))
  );

  if (message.action === "start" && kind === "class") {
    if (!["必修课", "选修课"].includes(message.group)) return { status: "请先打开必修课或选修课列表。" };
    if (run && !run.paused && !inClass) return { status: "已有课程页启用自动化。" };
    if (conflicting || tabs.some((item) => item.id === run?.playerId && isPlayer(pageKind(item.url)))) {
      return { status: "先关闭已有课程的播放页，再启动自动化。" };
    }
    return save({ classId: tab.id, group: message.group, phase: "list", course: null, playerId: null });
  }
  if (!run || (!inClass && !boundPlayer)) {
    return kind === "class" && run && !run.paused ? { status: "已有课程页启用自动化。" } : {};
  }

  if (message.action === "pause") return save({ ...run, paused: "自动化已暂停。" });
  if (conflicting && (boundPlayer || ["list", "chapters", "verify"].includes(run.phase))) {
    if (message.action === "resume") return { run, status: OTHER_PLAYER };
    if (!run.paused) return save({ ...run, paused: OTHER_PLAYER });
  }
  if (message.action === "resume" && !conflicting) {
    if (inPlayer) return save({ ...run, paused: "" });
    if (run.phase === "opening" && !run.playerId) {
      return save({ ...run, phase: "list", course: null, paused: "" });
    }
    return save({ ...run, paused: "" });
  }
  if (run.paused) return { run };

  if (boundPlayer && run.phase === "opening" && !conflicting) {
    run = { ...run, phase: "playing", playerId: tab.id };
    await save(run);
  }

  if (boundPlayer && tab.id === run.playerId && run.phase === "playing") {
    if (message.action === "finish") {
      const { course } = run;
      const hasNextChapter = kind === "chapter" && course.chapter + 1 < (course.chapters?.length ?? 0);
      const finishedCourse = hasNextChapter ? { ...course, chapter: course.chapter + 1 } : course;
      const next = {
        ...run, phase: "returning", course: finishedCourse,
        nextPhase: hasNextChapter ? "chapters" : "verify", since: Date.now(), verifyRefreshed: false,
        assessmentAttempted: null, assessmentUrl: null
      };
      await save(next);
      try {
        if (tab.id === run.classId) {
          await chrome.tabs.update(tab.id, { url: CLASS_PAGE });
        } else {
          await chrome.tabs.remove(tab.id);
          await chrome.tabs.reload(run.classId);
        }
      } catch (error) {
        console.error(error);
        return save({ ...next, paused: "请关闭当前播放页并返回课程列表。" });
      }
      return { run: next };
    }
    return { run, player: true };
  }

  if (!inClass) return {};
  if (run.phase === "opening" && Date.now() - run.since > OPEN_TIMEOUT) {
    return save({ ...run, paused: "未打开视频。请查看网站提示，再继续自动化。" });
  }
  if (run.phase === "playing" && !tabs.some((item) => item.id === run.playerId && isPlayer(pageKind(item.url)))) {
    return save({ ...run, phase: "list", playerId: null, paused: "播放页已离开。继续后将按网站进度恢复。" });
  }
  if (run.phase === "returning") {
    if (tabs.some((item) => item.id === run.playerId && isPlayer(pageKind(item.url)))) return { run };
    return save({ ...run, phase: run.nextPhase, playerId: null });
  }

  const assessmentOpen = tabs.some((item) =>
    [item.url, item.pendingUrl].some((url) => pageKind(url) === "assessment")
  );
  if (assessmentOpen) return { run, status: "等待完成并关闭课程评估或测验。" };

  if (message.action === "assess" &&
      (run.phase === "list" || (run.phase === "verify" && sameCourse(run.course, message.course))) &&
      !sameCourse(run.assessmentAttempted, message.course)) {
    return openAssessment(run, tab, message);
  }
  if (message.action === "open" && !conflicting && ["list", "chapters"].includes(run.phase)) {
    const course = message.course;
    if (run.phase === "chapters" && run.course.title !== course.title) return { run };
    return save({ ...run, phase: "opening", course, since: Date.now() }, { click: true });
  }
  if (message.action === "chapter" && run.phase === "opening" && !conflicting && !run.course.chapters?.length) {
    const course = { ...run.course, chapters: message.chapters, chapter: 0 };
    return save({ ...run, course, since: Date.now() }, { click: true });
  }
  if (message.action === "nextChapter" && run.phase === "opening" && !conflicting && run.course.chapters?.length) {
    return save({ ...run, since: Date.now() }, { click: true });
  }
  if (message.action === "verified" && run.phase === "verify") {
    return save({ ...run, phase: "list", course: null });
  }
  if (message.action === "verifyRefresh" && run.phase === "verify" &&
      !run.verifyRefreshed && Date.now() - run.since >= 10_000) {
    return save({ ...run, verifyRefreshed: true }, { reload: true });
  }
  if (message.action === "done" && run.phase === "list") {
    await chrome.storage.session.remove("run");
    return { status: "当前分组的课程已全部完成。" };
  }
  if (message.action === "blocked") return save({ ...run, paused: message.reason });
  return { run };
}
