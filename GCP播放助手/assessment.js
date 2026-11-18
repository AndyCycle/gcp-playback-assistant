let assessmentReady = false;
let ratingInProgress = null;
const completedRatings = new WeakSet();
let assessmentStage = "";
let assessmentSubmittedAt = 0;

function fillRating(control) {
  if (completedRatings.has(control)) return control.querySelector("input")?.value ? "ready" : "manual";
  if (ratingInProgress && ratingInProgress !== control) return "pending";

  const dropdowns = [...document.querySelectorAll(".el-select-dropdown")].filter(visible);
  if (!ratingInProgress) {
    if (dropdowns.length) return "manual";
    const input = control.querySelector("input");
    if (!visible(input) || input.disabled) return "manual";
    ratingInProgress = control;
    input.click();
    return "pending";
  }
  if (!dropdowns.length) return "pending";
  if (dropdowns.length !== 1) return "manual";
  const first = [...dropdowns[0].querySelectorAll(".el-select-dropdown__item")].find(
    (item) => visible(item) && !item.classList.contains("is-disabled")
  );
  if (!first) return "manual";
  completedRatings.add(control);
  ratingInProgress = null;
  first.click();
  return "pending";
}

function fillQuestion(question) {
  const textarea = question.querySelector("textarea");
  if (textarea) return textarea.value.trim() ? "ready" : "manual";

  const rating = question.querySelector(".el-select");
  if (rating) return fillRating(rating);

  const group = question.querySelector(".el-radio-group, .el-checkbox-group");
  if (!group) return "manual";
  const options = [...group.querySelectorAll("label.el-radio, label.el-checkbox")]
    .filter(visible).map((label) => ({ label, input: label.querySelector("input") }))
    .filter(({ input }) => input && !input.disabled);
  const [first, ...remaining] = options;
  if (!first) return "manual";
  const change = first.input.checked ?
    remaining.find(({ input }) => input.type === "checkbox" && input.checked) : first;
  if (!change) return "ready";
  change.label.click();
  return "pending";
}

function assessmentDialogButton(dialog, label) {
  return [...dialog.querySelectorAll(".el-message-box__btns button")].find(
    (button) => visible(button) && !button.disabled && compact(textOf(button)) === label
  );
}

async function onAssessment() {
  const result = await send(assessmentReady ? "tick" : "prepareAssessment");
  if (!result.run) {
    if (panel) panel.host.hidden = true;
    return;
  }
  assessmentReady = true;
  const current = result.run;
  if (current.paused) return updatePanel(current);

  const dialogs = [...document.querySelectorAll(DIALOGS)].filter(visible);
  if (dialogs.length) {
    if (dialogs.length !== 1) return updatePanel(current, "请查看评估页上的网站提示。");
    const [dialog] = dialogs;
    const message = compact(textOf(dialog.querySelector(".el-message-box__message")));
    if (assessmentStage === "confirm" && message === "确定要提交吗？") {
      const confirm = assessmentDialogButton(dialog, "确定");
      if (confirm) {
        assessmentStage = "submitted";
        assessmentSubmittedAt = Date.now();
        confirm.click();
        return updatePanel(current, "正在等待网站确认提交结果。");
      }
    }
    if (assessmentStage === "submitted" && dialog.querySelector(".el-message-box__status.el-icon-success")) {
      const close = assessmentDialogButton(dialog, "关闭");
      if (close) {
        assessmentStage = "finished";
        updatePanel(current, "评估提交成功，正在返回课程列表。");
        close.click();
        return;
      }
    }
    return updatePanel(current, "请查看评估页上的网站提示。");
  }
  if (assessmentStage) {
    const waiting = assessmentStage === "submitted" && Date.now() - assessmentSubmittedAt >= 10_000 ?
      "请查看网站反馈，确认评估是否已提交。" : "正在等待网站确认提交结果。";
    return updatePanel(current, waiting);
  }

  const box = document.querySelector(".exam_Box");
  const questions = [...(box?.querySelectorAll(".question") ?? [])].filter(visible);
  const submit = box?.querySelector("button.btn");
  if (!questions.length || !visible(submit) || compact(textOf(submit)) !== "提交") {
    return updatePanel(current, "正在等待课程评估问卷。");
  }
  const answers = questions.map(fillQuestion);
  if (answers.includes("manual")) return updatePanel(current, "请补填文字题或需要手动填写的题目。");
  if (answers.includes("pending") || submit.disabled) return updatePanel(current, "正在填写每题的第一个可选项。");

  assessmentStage = "confirm";
  submit.click();
  updatePanel(current, "正在提交课程评估。");
}
