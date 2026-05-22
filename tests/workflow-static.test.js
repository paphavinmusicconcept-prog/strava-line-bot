const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const indexSource = fs.readFileSync(path.join(root, "index.js"), "utf8");

function includesAll(source, snippets) {
  for (const snippet of snippets) {
    assert(
      source.includes(snippet),
      `Expected index.js to include: ${snippet}`
    );
  }
}

includesAll(indexSource, [
  "const WORKFLOW_SESSION_MEMORY_TYPE = \"workflow_session\"",
  "async function dbSaveWorkflowSession",
  "async function dbGetWorkflowSession",
  "async function dbDeleteWorkflowSession",
  "async function dbGetLatestWeightTrainingFeedback",
]);

includesAll(indexSource, [
  "function analyzeRunningLoadForWeightTraining",
  "async function startWeightTrainingFlow",
  "async function handleWeightTrainingPostback",
  "async function handleWeightTrainingText",
  "\"action=today_coach\": \"today_coach\"",
  "\"action=stat\": \"stat\"",
  "\"action=training_plan\": \"training_plan\"",
  "\"action=profile_setting\": \"profile_setting\"",
  "if (action === \"today_coach\")",
  "if (action === \"stat\")",
  "if (action === \"training_plan\")",
  "if (action === \"profile_setting\")",
  "\"action=recovery\": \"weight_training\"",
  "\"action=strength\": \"weight_training\"",
  "\"วิเคราะห์ recovery/strength\": \"weight_training\"",
  "handleWeightTrainingText(userId, text, event.replyToken)",
  "handleWeightTrainingPostback(userId, action, replyToken)",
  "action=wt_done",
  "weight_training_feedback",
]);

assert(
  !indexSource.includes("ช่วยแนะนำ recovery และ weight training จากข้อมูลการวิ่งล่าสุดของผม"),
  "Expected old recovery AI shortcut to be removed"
);

includesAll(indexSource, [
  "const hrZones = activity.hrZones || estimateHRZones(activity.pace)",
  "...buildHRZoneBar(hrZones)",
  "buildRunResultFlexMessage(activity, cleanText",
  "buildRunResultFlexMessage(gpxData, analysis",
]);

console.log("Workflow static tests passed");
