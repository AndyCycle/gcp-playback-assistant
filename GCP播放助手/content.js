const LIST_WAIT = 6_000;
const PLAYBACK_PAUSE_DELAY = 2_500;
const DIALOGS = '.el-dialog, .el-message-box, [role="alertdialog"], dialog[open], #multi_course, #audition_tips';
const CONTINUE = /^(?:是否继续(?:学习|观看|播放)|您是否继续(?:学习|观看|播放)|继续(?:学习|观看|播放))[？?。！!]?$/;
const CONFIRM = /^(?:确定|确认|继续(?:学习|观看|播放))$/;
let panel;
let run;
let assessmentButton;
let lastConfirmedDialog;
let playbackPause;
let watchedVideo;
let playbackWake;
let endedMedia;
let endedAt = 0;
let openedChapter = "";
let finishedGroup = "";
let busy = false;

function compact(value) {
  return (value ?? "").replace(/\s+/g, "");
}

function visible(element) {
  return Boolean(element?.getClientRects().length) &&
    element.ownerDocument.defaultView.getComputedStyle(element).visibility === "visible";
}

function textOf(element) {
  return (element?.textContent ?? "").trim();
}

function send(action, details = {}) {
  return chrome.runtime.sendMessage({ action, ...details });
}

function makePanel() {
  const host = document.createElement("aside");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; position: fixed; bottom: 18px; right: 18px; z-index: 2147483646; }
      section { box-sizing: border-box; width: min(308px, calc(100vw - 36px)); padding: 14px 16px;
        border: 1px solid #cddadb; border-radius: 12px; background: #f7fbfb; color: #152f35;
        box-shadow: 0 4px 20px #152f3520; font: 14px/1.55 system-ui, "Microsoft YaHei", sans-serif; }
      header { font-size: 15px; font-weight: 700; }
      p { margin: 6px 0 10px; overflow-wrap: anywhere; }
      .actions { display: flex; flex-wrap: wrap; gap: 6px; }
      button { font: inherit; color: #16424a; background: white; border: 1px solid #bdd1d2;
        padding: 4px 9px; border-radius: 6px; cursor: pointer; }
      button:first-child { background: #17535c; color: white; border-color: #17535c; }
      button:disabled { cursor: wait; opacity: .65; }
      [hidden] { display: none; }
    </style>
    <section aria-label="GCP 课件播放助手">
      <header>GCP 课件播放助手</header>
      <p role="status"></p>
      <div class="actions">
        <button type="button"></button>
        <button type="button" data-action="assessment" hidden>前往评估</button>
        <button type="button" data-action="refresh" hidden>刷新课程状态</button>
      </div>
    </section>`;
  const main = root.querySelector("button");
  const assessment = root.querySelector('[data-action="assessment"]');
  const refresh = root.querySelector('[data-action="refresh"]');
  main.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    main.disabled = true;
    try {
      const action = !run ? "start" : run.paused ? "resume" : "pause";
      const result = await send(action, { group: currentGroup() });
      if (result.run) finishedGroup = "";
      updatePanel(result.run, result.status);
    } catch (error) {
      console.error(error);
      updatePanel(run, "控件暂时无法连接。请刷新页面。");
    } finally {
      main.disabled = false;
      busy = false;
    }
  });
  assessment.addEventListener("click", () => {
    if (assessmentButton) reveal(assessmentButton);
    if (visible(assessmentButton)) assessmentButton.click();
  });
  refresh.addEventListener("click", () => location.reload());
  document.body.append(host);
  return { host, status: root.querySelector("p"), main, assessment, refresh };
}

function updatePanel(current, status = "", assess = null, refresh = false) {
  run = current;
  assessmentButton = assess;
  panel ??= makePanel();
  panel.host.hidden = false;
  panel.main.textContent = !run ? "开始自动化" : run.paused ? "继续自动化" : "暂停自动化";
  panel.status.textContent = status || run?.paused || "准备按课程顺序播放。";
  panel.assessment.hidden = !assess;
  panel.refresh.hidden = !refresh;
}

function currentGroup() {
  return textOf(document.querySelector(".detail_tool > li.active"));
}

function reveal(element) {
  if (visible(element)) return;
  const header = element.closest(".el-collapse-item")?.querySelector(".el-collapse-item__header");
  if (visible(header) && header.getAttribute("aria-expanded") !== "true") header.click();
}

function courseRows(section) {
  return [...document.querySelectorAll(`.${section} .gj_top_list_box > li`)].flatMap((row) => {
    const title = textOf(row.querySelector(".text_title"));
    if (!title) return [];
    const module = textOf(row.closest(".el-collapse-item")?.querySelector(".el-collapse-item__header"));
    const assessment = [...row.querySelectorAll(".SaveButton .Cancel")].find(
      (button) => compact(textOf(button)) === "我要评估"
    );
    return [{ title, module, assessment, button: row.querySelector(".SaveButton .Save") }];
  });
}

async function selectCourse(current, row) {
  if (!visible(row.button)) {
    if (row.button) reveal(row.button);
    updatePanel(current, `正在定位「${row.title}」。`);
    return;
  }
  const course = current.phase === "chapters" ? current.course : { title: row.title, module: row.module };
  const result = await send("open", { course });
  if (result.click && visible(row.button)) {
    openedChapter = "";
    row.button.click();
  }
  updatePanel(result.run, result.status || `正在打开「${row.title}」。`);
}

async function chooseChapter(current, dialog) {
  const items = [...dialog.querySelectorAll(".course_chapter .chapter_item")].filter(visible);
  if (!items.length) return;
  const names = items.map((item) => textOf(item.querySelector(".chapter_name")));
  const title = textOf(dialog.querySelector(".el-dialog__title"));
  const course = current.course;
  if (title !== course.title) return;

  const index = course.chapter ?? 0;
  const key = `${current.since}:${index}`;
  if (openedChapter === key) return;
  if (course.chapters && (course.chapters.length !== names.length ||
      course.chapters.some((name, position) => name !== names[position]))) {
    const result = await send("blocked", { reason: "网站的课件目录已变化。请核对后继续。" });
    updatePanel(result.run);
    return;
  }
  const result = await send(course.chapters ? "nextChapter" : "chapter", { chapters: names });
  if (result.click && visible(items[index])) {
    openedChapter = `${result.run.since}:${index}`;
    items[index].click();
  }
  updatePanel(result.run, result.status || `正在打开「${names[index]}」。`);
}

async function startAssessment(current, row) {
  const entry = row.assessment;
  reveal(entry);
  const status = `请完成「${row.title}」的课程评估。提交后会检查下一门。`;
  if (!visible(entry) || sameCourse(current.assessmentAttempted, row)) {
    return updatePanel(current, status, entry, true);
  }

  const token = crypto.randomUUID();
  entry.setAttribute(ASSESSMENT_ENTRY, token);
  try {
    const course = { title: row.title, module: row.module };
    const result = await send("assess", { course, token });
    updatePanel(result.run ?? current, result.status || status, entry, true);
  } finally {
    entry.removeAttribute(ASSESSMENT_ENTRY);
  }
}

async function onClass(result) {
  const current = result.run;
  const group = currentGroup();
  if (result.status || current?.paused) return updatePanel(current, result.status);
  if (!current) {
    const instruction = finishedGroup && group === finishedGroup ? "当前分组的课程已全部完成。" :
      /^(必修课|选修课)$/.test(group) ? "在当前课程分组按顺序播放。请先关闭已打开的课程视频。" :
      "请先登录并打开必修课或选修课列表。";
    return updatePanel(null, instruction);
  }
  if (current.phase === "returning" || current.phase === "playing") {
    return updatePanel(current, `当前课程为「${current.course.title}」。`);
  }
  const dialogs = [...document.querySelectorAll(DIALOGS)].filter(visible);
  if (dialogs.length) {
    const chapter = dialogs.find((dialog) => dialog.querySelector(".course_chapter"));
    if (chapter && dialogs.length === 1 && current.phase === "opening") {
      await chooseChapter(current, chapter);
      return;
    }
    return updatePanel(current, "请处理网站提示，控件随后继续。");
  }
  if (current.phase === "opening") return updatePanel(current, `正在打开「${current.course.title}」。`);

  if (group !== current.group || !/^(必修课|选修课)$/.test(group)) {
    const tab = [...document.querySelectorAll(".detail_tool > li")].find(
      (item) => textOf(item) === current.group
    );
    if (visible(tab) && group !== current.group) tab.click();
    return updatePanel(current, "正在等待课程列表。");
  }
  if ([...document.querySelectorAll(".detail_component .el-loading-mask")].some(visible)) {
    return updatePanel(current, "正在读取网站课程进度。");
  }
  const complete = courseRows("complete_course");
  const incomplete = courseRows("uncomplete_course");
  if (current.phase === "chapters") {
    const row = [...incomplete, ...complete].find((item) => sameCourse(item, current.course));
    return row ? selectCourse(current, row) : updatePanel(current, "正在等待课件目录。", null, true);
  }
  if (current.phase === "verify") {
    const matches = complete.filter((row) => sameCourse(row, current.course));
    if (matches.length !== 1) {
      if (!current.verifyRefreshed && Date.now() - current.since >= 10_000) {
        const refresh = await send("verifyRefresh");
        if (refresh.reload) location.reload();
      }
      return updatePanel(current, `已播完「${current.course.title}」。等待网站将课程列为已完成。`, null, true);
    }
    if (matches[0].assessment) return startAssessment(current, matches[0]);
    const next = await send("verified");
    return updatePanel(next.run, next.status || "网站已确认课程完成。");
  }
  const pending = complete.find((row) => row.assessment);
  if (pending) return startAssessment(current, pending);
  const next = incomplete.find((row) => textOf(row.button) === "开始学习");
  if (next) return selectCourse(current, next);
  if (complete.length) {
    finishedGroup = current.group;
    const done = await send("done");
    return updatePanel(done.run, done.status);
  }
  return updatePanel(current, "正在等待课程列表。", null, true);
}

function playerDocuments() {
  const documents = [document];
  for (const doc of documents) {
    for (const frame of doc.querySelectorAll("iframe")) {
      if (visible(frame) && frame.contentDocument) documents.push(frame.contentDocument);
    }
  }
  return documents;
}

function continueButton(dialog) {
  const parts = [...dialog.querySelectorAll(".el-dialog__body, .el-message-box__message, p, div")];
  if (!parts.some((part) => visible(part) && CONTINUE.test(compact(textOf(part))))) return null;
  return [...dialog.querySelectorAll('button, [role="button"], .close_btn')].find(
    (button) => visible(button) && !button.disabled && CONFIRM.test(compact(textOf(button)))
  );
}

function recordPlaybackPause(video) {
  if (playbackPause?.video === video && playbackPause.position === video.currentTime) return;
  playbackPause = { video, position: video.currentTime, since: performance.now(), attempted: false, settled: false };
}

function playerDialogs(documents) {
  return documents.flatMap((doc) => [...doc.querySelectorAll(DIALOGS)].filter(visible));
}

function playbackDelay() {
  return document.hidden || !document.hasFocus() ? 0 : PLAYBACK_PAUSE_DELAY;
}

function onVideoPause(event) {
  const video = event.currentTarget;
  if (!video.paused || video.ended) return;
  recordPlaybackPause(video);
  // Resume from this event before background timer throttling can delay the next poll.
  if (playbackDelay() === 0 && !busy && run?.phase === "playing" &&
      !run.paused && !playerDialogs(playerDocuments()).length) {
    recoverPlayback(video, 0);
  }
  clearTimeout(playbackWake);
  playbackWake = setTimeout(tick, PLAYBACK_PAUSE_DELAY);
}

function watchVideo(video) {
  if (watchedVideo === video) return;
  watchedVideo?.removeEventListener("pause", onVideoPause);
  clearTimeout(playbackWake);
  watchedVideo = video;
  watchedVideo?.addEventListener("pause", onVideoPause);
}

function recoverPlayback(video, delay = PLAYBACK_PAUSE_DELAY) {
  if (!video?.paused || video.ended) {
    playbackPause = null;
    return "";
  }
  if (video.error) return "播放器报告异常，请查看视频页提示。";
  if (video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return "正在等待播放器加载视频。";
  }

  recordPlaybackPause(video);
  const pause = playbackPause;
  if (performance.now() - pause.since < delay) return "检测到暂停，正在等待播放器响应。";
  if (!pause.attempted) {
    pause.attempted = true;
    video.play().then(
      () => { pause.settled = true; },
      () => { pause.settled = true; }
    );
  }
  return pause.settled ? "播放器仍处于暂停，请点播放按钮继续。" : "正在从当前进度恢复播放。";
}

async function onPlayer(result, kind) {
  const current = result.run;
  if (!current) {
    watchVideo(null);
    if (panel) panel.host.hidden = true;
    return;
  }
  if (current.paused || result.status) {
    watchVideo(null);
    playbackPause = null;
    return updatePanel(current, result.status);
  }
  if (!result.player) return;
  const documents = playerDocuments();
  const video = documents.flatMap((doc) => [...doc.querySelectorAll("video")]).find(visible);
  watchVideo(video);
  const dialogs = playerDialogs(documents);
  if (!dialogs.includes(lastConfirmedDialog)) lastConfirmedDialog = null;
  if (dialogs.length) {
    playbackPause = null;
    const dialog = dialogs.length === 1 ? dialogs[0] : null;
    const confirm = dialog && continueButton(dialog);
    if (confirm && video && lastConfirmedDialog !== dialog) {
      lastConfirmedDialog = dialog;
      confirm.click();
      return updatePanel(current, "已确认继续播放。");
    }
    return updatePanel(current, "播放器正在等待确认。请查看站内提示。");
  }

  const menu = [...document.querySelectorAll(".course_menu .menu_item")];
  const last = menu.at(-1);
  if (!video?.ended || (kind === "player" && (!last || !last.classList.contains("currentChapter")))) {
    endedMedia = null;
    return updatePanel(current, recoverPlayback(video, playbackDelay()) || `正在播放「${current.course.title}」。`);
  }
  if (endedMedia !== video) {
    endedMedia = video;
    endedAt = Date.now();
  }
  if (Date.now() - endedAt < LIST_WAIT) return updatePanel(current, "课件已播完，等待网站保存进度。");
  const finished = await send("finish");
  if (finished.run) updatePanel(finished.run, finished.status || "正在返回课程列表。");
}

async function tick() {
  if (busy) return;
  const kind = pageKind(location.href);
  const assessment = isCourseAssessment(location.href);
  if (!isPlayer(kind)) watchVideo(null);
  if (!assessment && kind !== "class" && !isPlayer(kind)) {
    if (panel) panel.host.hidden = true;
    return;
  }
  busy = true;
  try {
    if (assessment) {
      await onAssessment();
      return;
    }
    const result = await send("tick");
    if (kind !== pageKind(location.href)) return;
    if (kind === "class") await onClass(result);
    else await onPlayer(result, kind);
  } catch (error) {
    console.error(error);
    if (panel) updatePanel(run, "控件暂时无法连接。请刷新页面。");
  } finally {
    busy = false;
  }
}

window.addEventListener("hashchange", tick);
setInterval(tick, 1_000);
tick();
