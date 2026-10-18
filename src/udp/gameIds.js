// The game's ID tables for sessions and tracks (F1 25/26 UDP spec), for labels.

const SESSION_TYPES = {
  1: 'Practice 1', 2: 'Practice 2', 3: 'Practice 3', 4: 'Short practice',
  5: 'Qualifying 1', 6: 'Qualifying 2', 7: 'Qualifying 3', 8: 'Short qualifying', 9: 'One-shot qualifying',
  10: 'Sprint shootout 1', 11: 'Sprint shootout 2', 12: 'Sprint shootout 3', 13: 'Short sprint shootout', 14: 'One-shot sprint shootout',
  15: 'Race', 16: 'Race 2', 17: 'Race 3', 18: 'Time trial',
};
const TRACKS = {
  0: 'Melbourne', 2: 'Shanghai', 3: 'Bahrain', 4: 'Barcelona', 5: 'Monaco', 6: 'Montreal', 7: 'Silverstone',
  9: 'Hungaroring', 10: 'Spa', 11: 'Monza', 12: 'Singapore', 13: 'Suzuka', 14: 'Abu Dhabi', 15: 'Austin',
  16: 'Interlagos', 17: 'Red Bull Ring', 19: 'Mexico City', 20: 'Baku', 26: 'Zandvoort', 27: 'Imola',
  29: 'Jeddah', 30: 'Miami', 31: 'Las Vegas', 32: 'Losail', 39: 'Silverstone (reverse)', 40: 'Red Bull Ring (reverse)', 41: 'Zandvoort (reverse)',
};

module.exports = { SESSION_TYPES, TRACKS };
