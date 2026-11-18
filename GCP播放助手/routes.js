const SITE = "www.nmpaied.com";
const CDN = "cdn.nmpaied.com";
const CLASS_PAGE = "https://www.nmpaied.com/pc/#/person_center/my_class/user_class?show_details_id=161&id=2";
const SITE_HOSTS = [`https://${SITE}/*`, `https://${CDN}/*`];
const ASSESSMENT_ENTRY = "data-gcp-assessment-entry";

function pageKind(href) {
  if (!href) return "";
  const url = new URL(href);
  if (url.protocol !== "https:") return "";
  if (url.hostname === CDN && url.pathname === "/scorm_player/zj_play.html") return "chapter";
  if (url.hostname !== SITE || url.pathname !== "/pc/") return "";
  const [route, query] = url.hash.slice(1).split("?");
  if (route === "/video_play" || route === "/scorm_play") return "player";
  if (route === "/assess_list" || route === "/course_exam") return "assessment";
  if (route === "/person_center/my_class/user_class") {
    const values = new URLSearchParams(query);
    if (values.get("show_details_id") === "161" && values.get("id") === "2") return "class";
  }
  return "";
}

function isPlayer(kind) {
  return kind === "player" || kind === "chapter";
}

function isCourseAssessment(href) {
  if (pageKind(href) !== "assessment") return false;
  const [route, query] = new URL(href).hash.slice(1).split("?");
  const values = new URLSearchParams(query);
  return route === "/assess_list" && values.get("assess_type") === "1" &&
    values.get("assess_page") === "online" && values.get("class_course_id") === "161" &&
    Boolean(values.get("assess_id") && values.get("class_id"));
}

function sameCourse(left, right) {
  return Boolean(left && right && left.title === right.title && left.module === right.module);
}
