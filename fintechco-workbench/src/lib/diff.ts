export interface DiffLine {
  kind: "ctx" | "add" | "del";
  text: string;
  oldNo?: number;
  newNo?: number;
}

/** Line-level LCS diff. Inputs are small source files, so O(n*m) is fine. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before ? before.replace(/\n$/, "").split("\n") : [];
  const b = after ? after.replace(/\n$/, "").split("\n") : [];
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i], oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push({ kind: "add", text: b[j], newNo: j + 1 });
      j++;
    } else {
      out.push({ kind: "del", text: a[i], oldNo: i + 1 });
      i++;
    }
  }
  return out;
}

export function diffStats(before: string, after: string): { added: number; removed: number } {
  const d = diffLines(before, after);
  return {
    added: d.filter((l) => l.kind === "add").length,
    removed: d.filter((l) => l.kind === "del").length,
  };
}
