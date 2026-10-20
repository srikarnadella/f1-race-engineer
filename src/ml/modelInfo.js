// The overtake model as the Models tab shows it: served at /api/models, and
// copied into the demo site's data by scripts/build-demo-site.js.
function overtakeInfo(m = require('./models/overtake-gbdt.json')) {
  return {
    kind: m.kind,
    question: m.question,
    horizonS: m.horizonS,
    trainedOn: m.trainedOn,
    evaluation: m.evaluation,
    trees: m.trees.length,
    importance: m.importance,
  };
}

module.exports = { overtakeInfo };
