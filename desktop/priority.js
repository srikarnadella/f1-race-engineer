// Windows process priorities for "easy on the game" (roadmap W8): Undercut shares the PC with F1 26, so
// all of its processes run below normal and the game's threads win any contest for a core. 10 and 0 are
// Node's PRIORITY_BELOW_NORMAL and PRIORITY_NORMAL.
const BELOW_NORMAL = 10;
const NORMAL = 0;

// Sets every pid; one that has already gone (a renderer that restarted) is skipped. Returns how many were set.
function setPriorities(pids, easy, setPriority) {
  let n = 0;
  for (const pid of pids) {
    try {
      setPriority(pid, easy ? BELOW_NORMAL : NORMAL);
      n++;
    } catch (_) { /* gone, or not ours to change */ }
  }
  return n;
}

module.exports = { setPriorities };
