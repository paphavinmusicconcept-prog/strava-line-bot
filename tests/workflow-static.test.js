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
  "handleWeightTrainingText(userId, text, event.replyToken)",
  "handleWeightTrainingPostback(userId, action, replyToken)",
  "action=wt_done",
  "weight_training_feedback",
]);

includesAll(indexSource, [
  "const hrZones = activity.hrZones || estimateHRZones(activity.pace)",
  "...buildHRZoneBar(hrZones)",
  "buildRunResultFlexMessage(activity, cleanText",
  "buildRunResultFlexMessage(gpxData, analysis",
]);

console.log("Workflow static tests passed");
