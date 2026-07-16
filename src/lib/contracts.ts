/**
 * Pure coding-contract solvers. 0 GB — no `@ns` runtime import, no NS-named identifiers, no
 * top-level NS calls — so importing `{ SOLVERS }` into the runner adds nothing to its RAM.
 *
 * Every solver is a faithful port of the game's own `getAnswer` (or, where `getAnswer` returns
 * null, of its `solver` acceptance test) from `bitburner-src/src/CodingContract/contracts/*.ts`.
 * That is deliberate: the game validates an attempt by comparing against the SAME algorithm, so
 * replicating it exactly is the only way to guarantee a match. `attempt` takes the TYPED answer
 * (Contract.isValid only string-parses `convertAnswer` when the answer is a string), so these
 * return native values — numbers, arrays, strings, and a real `bigint` for Square Root.
 *
 * Keyed by the exact `getContractType()` display string. The mapped type below makes the object
 * incomplete-by-construction: every one of the 30 `CodingContractSignatures` keys must be present
 * with the game's `[dataType, answerType]` shape, or `tsc` fails.
 */

import type { CodingContractSignatures } from '@ns';

type Solvers = {
  [K in keyof CodingContractSignatures]: (data: CodingContractSignatures[K][0]) => CodingContractSignatures[K][1];
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Floor integer square root of a non-negative bigint (Newton's method). */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n < 0n ? 0n : n;
  // Initial overestimate: 2^ceil(bits/2) >= sqrt(n). Number()/Math.sqrt would overflow at ~200 digits.
  const bits = n.toString(2).length;
  let x = 1n << BigInt(Math.ceil(bits / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  while (x * x > n) x -= 1n;
  return x;
}

/** Extended-Hamming encode of an integer, verbatim from HammingCode.ts `HammingEncode`. */
function hammingEncode(value: number): string {
  const enc: number[] = [0];
  const dataBits: number[] = value
    .toString(2)
    .split('')
    .reverse()
    .map((v) => parseInt(v));

  let k = dataBits.length;
  for (let i = 1; k > 0; i++) {
    if ((i & (i - 1)) != 0) enc[i] = dataBits[--k];
    else enc[i] = 0;
  }

  let parityNumber = 0;
  for (let i = 0; i < enc.length; i++) if (enc[i]) parityNumber ^= i;

  const parityArray = parityNumber
    .toString(2)
    .split('')
    .reverse()
    .map((v) => parseInt(v));
  for (let i = 0; i < parityArray.length; i++) enc[2 ** i] = parityArray[i] ? 1 : 0;

  parityNumber = 0;
  for (let i = 0; i < enc.length; i++) if (enc[i]) parityNumber++;
  enc[0] = parityNumber % 2 == 0 ? 0 : 1;

  return enc.join('');
}

/** Extended-Hamming decode (single-bit correction), verbatim from HammingCode.ts `HammingDecode`. */
function hammingDecode(encoded: string): number {
  let err = 0;
  const bits: number[] = [];
  const chars = encoded.split('');
  for (let i = 0; i < chars.length; ++i) {
    const bit = parseInt(chars[i]);
    bits[i] = bit;
    if (bit) err ^= +i;
  }
  if (err) bits[err] = bits[err] ? 0 : 1;

  let ans = '';
  for (let i = 1; i < bits.length; i++) if ((i & (i - 1)) != 0) ans += bits[i];
  return parseInt(ans, 2);
}

/** LZ decode, verbatim from Compression.ts `comprLZDecode` (returns '' on invalid). */
function lzDecode(compr: string): string {
  let plain = '';
  for (let i = 0; i < compr.length;) {
    const literalLength = compr.charCodeAt(i) - 0x30;
    if (literalLength < 0 || literalLength > 9 || i + 1 + literalLength > compr.length) return '';
    plain += compr.substring(i + 1, i + 1 + literalLength);
    i += 1 + literalLength;
    if (i >= compr.length) break;

    const backrefLength = compr.charCodeAt(i) - 0x30;
    if (backrefLength < 0 || backrefLength > 9) return '';
    else if (backrefLength === 0) ++i;
    else {
      if (i + 1 >= compr.length) return '';
      const backrefOffset = compr.charCodeAt(i + 1) - 0x30;
      if ((backrefLength > 0 && (backrefOffset < 1 || backrefOffset > 9)) || backrefOffset > plain.length) return '';
      for (let j = 0; j < backrefLength; ++j) plain += plain[plain.length - backrefOffset];
      i += 2;
    }
  }
  return plain;
}

/**
 * Optimal LZ encode, ported from Compression.ts `comprLZEncode`. The game's version breaks
 * equal-length ties with Math.random(); dropped here (keep-first is equally minimal and
 * deterministic — the validator only checks the answer decodes to `plain` and is no longer than
 * the game's own minimal encoding).
 */
function lzEncode(plain: string): string {
  let curState: (string | null)[][] = Array.from(Array(10), () => Array<string | null>(10).fill(null));
  let newState: (string | null)[][] = Array.from(Array(10), () => Array<string | null>(10));

  function set(state: (string | null)[][], i: number, j: number, str: string): void {
    const current = state[i][j];
    if (current == null || str.length < current.length) state[i][j] = str;
  }

  curState[0][1] = '';

  for (let i = 1; i < plain.length; ++i) {
    for (const row of newState) row.fill(null);
    const c = plain[i];

    for (let length = 1; length <= 9; ++length) {
      const str = curState[0][length];
      if (str == null) continue;
      if (length < 9) set(newState, 0, length + 1, str);
      else set(newState, 0, 1, str + '9' + plain.substring(i - 9, i) + '0');
      for (let offset = 1; offset <= Math.min(9, i); ++offset) {
        if (plain[i - offset] === c) set(newState, offset, 1, str + String(length) + plain.substring(i - length, i));
      }
    }

    for (let offset = 1; offset <= 9; ++offset) {
      for (let length = 1; length <= 9; ++length) {
        const str = curState[offset][length];
        if (str == null) continue;
        if (plain[i - offset] === c) {
          if (length < 9) set(newState, offset, length + 1, str);
          else set(newState, offset, 1, str + '9' + String(offset) + '0');
        }
        set(newState, 0, 1, str + String(length) + String(offset));
        for (let newOffset = 1; newOffset <= Math.min(9, i); ++newOffset) {
          if (plain[i - newOffset] === c) set(newState, newOffset, 1, str + String(length) + String(offset) + '0');
        }
      }
    }

    const tmp = newState;
    newState = curState;
    curState = tmp;
  }

  let result: string | null = null;
  for (let len = 1; len <= 9; ++len) {
    let str = curState[0][len];
    if (str == null) continue;
    str += String(len) + plain.substring(plain.length - len, plain.length);
    if (result == null || str.length < result.length) result = str;
  }
  for (let offset = 1; offset <= 9; ++offset) {
    for (let len = 1; len <= 9; ++len) {
      let str = curState[offset][len];
      if (str == null) continue;
      str += String(len) + '' + String(offset);
      if (result == null || str.length < result.length) result = str;
    }
  }

  return result ?? '';
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const SOLVERS: Solvers = {
  'Find Largest Prime Factor': (data) => {
    let fac = 2;
    let n = data;
    while (n > (fac - 1) * (fac - 1)) {
      while (n % fac === 0) n = Math.round(n / fac);
      ++fac;
    }
    return n === 1 ? fac - 1 : n;
  },

  'Subarray with Maximum Sum': (data) => {
    const nums = data.slice();
    for (let i = 1; i < nums.length; i++) nums[i] = Math.max(nums[i], nums[i] + nums[i - 1]);
    return Math.max(...nums);
  },

  'Total Ways to Sum': (data) => {
    const ways: number[] = [1];
    ways.length = data + 1;
    ways.fill(0, 1);
    for (let i = 1; i < data; ++i) for (let j = i; j <= data; ++j) ways[j] += ways[j - i];
    return ways[data];
  },

  'Total Ways to Sum II': (data) => {
    const n = data[0];
    const s = data[1];
    const ways: number[] = [1];
    ways.length = n + 1;
    ways.fill(0, 1);
    for (let i = 0; i < s.length; i++) for (let j = s[i]; j <= n; j++) ways[j] += ways[j - s[i]];
    return ways[n];
  },

  'Spiralize Matrix': (data) => {
    const spiral: number[] = [];
    const m = data.length;
    const n = data[0].length;
    let u = 0;
    let d = m - 1;
    let l = 0;
    let r = n - 1;
    let k = 0;
    let done = false;
    while (!done) {
      for (let col = l; col <= r; col++) spiral[k++] = data[u][col];
      if (++u > d) {
        done = true;
        continue;
      }
      for (let row = u; row <= d; row++) spiral[k++] = data[row][r];
      if (--r < l) {
        done = true;
        continue;
      }
      for (let col = r; col >= l; col--) spiral[k++] = data[d][col];
      if (--d < u) {
        done = true;
        continue;
      }
      for (let row = d; row >= u; row--) spiral[k++] = data[row][l];
      if (++l > r) {
        done = true;
        continue;
      }
    }
    return spiral;
  },

  'Array Jumping Game': (data) => {
    const n = data.length;
    let i = 0;
    for (let reach = 0; i < n && i <= reach; ++i) reach = Math.max(i + data[i], reach);
    return i === n ? 1 : 0;
  },

  'Array Jumping Game II': (data) => {
    const n = data.length;
    let reach = 0;
    let jumps = 0;
    let lastJump = -1;
    while (reach < n - 1) {
      let jumpedFrom = -1;
      for (let i = reach; i > lastJump; i--) {
        if (i + data[i] > reach) {
          reach = i + data[i];
          jumpedFrom = i;
        }
      }
      if (jumpedFrom === -1) {
        jumps = 0;
        break;
      }
      lastJump = jumpedFrom;
      jumps++;
    }
    return jumps;
  },

  'Merge Overlapping Intervals': (data) => {
    const intervals = data.slice();
    intervals.sort((a, b) => a[0] - b[0]);
    const result: [number, number][] = [];
    let start = intervals[0][0];
    let end = intervals[0][1];
    for (const interval of intervals) {
      if (interval[0] <= end) end = Math.max(end, interval[1]);
      else {
        result.push([start, end]);
        start = interval[0];
        end = interval[1];
      }
    }
    result.push([start, end]);
    return result;
  },

  'Generate IP Addresses': (data) => {
    const ret: string[] = [];
    for (let a = 1; a <= 3; ++a) {
      for (let b = 1; b <= 3; ++b) {
        for (let c = 1; c <= 3; ++c) {
          for (let d = 1; d <= 3; ++d) {
            if (a + b + c + d === data.length) {
              const A = parseInt(data.substring(0, a), 10);
              const B = parseInt(data.substring(a, a + b), 10);
              const C = parseInt(data.substring(a + b, a + b + c), 10);
              const D = parseInt(data.substring(a + b + c, a + b + c + d), 10);
              if (A <= 255 && B <= 255 && C <= 255 && D <= 255) {
                const ip = [A, '.', B, '.', C, '.', D].join('');
                if (ip.length === data.length + 3) ret.push(ip);
              }
            }
          }
        }
      }
    }
    return ret;
  },

  'Algorithmic Stock Trader I': (data) => {
    let maxCur = 0;
    let maxSoFar = 0;
    for (let i = 1; i < data.length; ++i) {
      maxCur = Math.max(0, maxCur + data[i] - data[i - 1]);
      maxSoFar = Math.max(maxCur, maxSoFar);
    }
    return maxSoFar;
  },

  'Algorithmic Stock Trader II': (data) => {
    let profit = 0;
    for (let p = 1; p < data.length; ++p) profit += Math.max(data[p] - data[p - 1], 0);
    return profit;
  },

  'Algorithmic Stock Trader III': (data) => {
    let hold1 = Number.MIN_SAFE_INTEGER;
    let hold2 = Number.MIN_SAFE_INTEGER;
    let release1 = 0;
    let release2 = 0;
    for (const price of data) {
      release2 = Math.max(release2, hold2 + price);
      hold2 = Math.max(hold2, release1 - price);
      release1 = Math.max(release1, hold1 + price);
      hold1 = Math.max(hold1, price * -1);
    }
    return release2;
  },

  'Algorithmic Stock Trader IV': (data) => {
    const k = data[0];
    const prices = data[1];
    const len = prices.length;
    if (len < 2) return 0;
    if (k > len / 2) {
      let res = 0;
      for (let i = 1; i < len; ++i) res += Math.max(prices[i] - prices[i - 1], 0);
      return res;
    }
    const hold: number[] = [];
    const rele: number[] = [];
    hold.length = k + 1;
    rele.length = k + 1;
    for (let i = 0; i <= k; ++i) {
      hold[i] = Number.MIN_SAFE_INTEGER;
      rele[i] = 0;
    }
    for (let i = 0; i < len; ++i) {
      const cur = prices[i];
      for (let j = k; j > 0; --j) {
        rele[j] = Math.max(rele[j], hold[j] + cur);
        hold[j] = Math.max(hold[j], rele[j - 1] - cur);
      }
    }
    return rele[k];
  },

  'Minimum Path Sum in a Triangle': (data) => {
    const n = data.length;
    const dp = data[n - 1].slice();
    for (let i = n - 2; i > -1; --i) {
      for (let j = 0; j < data[i].length; ++j) dp[j] = Math.min(dp[j], dp[j + 1]) + data[i][j];
    }
    return dp[0];
  },

  'Unique Paths in a Grid I': (data) => {
    const n = data[0];
    const m = data[1];
    const currentRow: number[] = [];
    currentRow.length = n;
    for (let i = 0; i < n; i++) currentRow[i] = 1;
    for (let row = 1; row < m; row++) for (let i = 1; i < n; i++) currentRow[i] += currentRow[i - 1];
    return currentRow[n - 1];
  },

  'Unique Paths in a Grid II': (data) => {
    const grid: number[][] = data.map((row) => row.slice());
    for (let i = 0; i < grid.length; i++) {
      for (let j = 0; j < grid[0].length; j++) {
        if (grid[i][j] == 1) grid[i][j] = 0;
        else if (i == 0 && j == 0) grid[0][0] = 1;
        else grid[i][j] = (i > 0 ? grid[i - 1][j] : 0) + (j > 0 ? grid[i][j - 1] : 0);
      }
    }
    return grid[grid.length - 1][grid[0].length - 1];
  },

  'Shortest Path in a Grid': (data) => {
    const height = data.length;
    const width = data[0].length;
    const dstY = height - 1;
    const dstX = width - 1;
    if (data[0][0] === 1 || data[dstY][dstX] === 1) return '';

    const dist: number[][] = Array.from({ length: height }, () => Array<number>(width).fill(Infinity));
    const prev: ([number, number] | null)[][] = Array.from({ length: height }, () =>
      Array<[number, number] | null>(width).fill(null),
    );
    dist[0][0] = 0;
    const queue: [number, number][] = [[0, 0]];
    const steps: [number, number][] = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    while (queue.length > 0) {
      const [y, x] = queue.shift() as [number, number];
      for (const [dy, dx] of steps) {
        const ny = y + dy;
        const nx = x + dx;
        if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue;
        if (data[ny][nx] !== 0) continue;
        if (dist[ny][nx] === Infinity) {
          dist[ny][nx] = dist[y][x] + 1;
          prev[ny][nx] = [y, x];
          queue.push([ny, nx]);
        }
      }
    }
    if (!Number.isFinite(dist[dstY][dstX])) return '';

    const moves: string[] = [];
    let cy = dstY;
    let cx = dstX;
    while (cy !== 0 || cx !== 0) {
      const p = prev[cy][cx] as [number, number];
      const dy = cy - p[0];
      const dx = cx - p[1];
      moves.push(dy === -1 ? 'U' : dy === 1 ? 'D' : dx === -1 ? 'L' : 'R');
      cy = p[0];
      cx = p[1];
    }
    return moves.reverse().join('');
  },

  'Sanitize Parentheses in Expression': (data) => {
    let left = 0;
    let right = 0;
    for (let i = 0; i < data.length; ++i) {
      if (data[i] === '(') ++left;
      else if (data[i] === ')') {
        if (left > 0) --left;
        else ++right;
      }
    }
    const res: string[] = [];
    const dfs = (pair: number, index: number, l: number, r: number, s: string, solution: string): void => {
      if (s.length === index) {
        if (l === 0 && r === 0 && pair === 0 && !res.includes(solution)) res.push(solution);
        return;
      }
      if (s[index] === '(') {
        if (l > 0) dfs(pair, index + 1, l - 1, r, s, solution);
        dfs(pair + 1, index + 1, l, r, s, solution + s[index]);
      } else if (s[index] === ')') {
        if (r > 0) dfs(pair, index + 1, l, r - 1, s, solution);
        if (pair > 0) dfs(pair - 1, index + 1, l, r, s, solution + s[index]);
      } else {
        dfs(pair, index + 1, l, r, s, solution + s[index]);
      }
    };
    dfs(0, 0, left, right, data, '');
    return res;
  },

  'Find All Valid Math Expressions': (data) => {
    const num = data[0];
    const target = data[1];
    const result: string[] = [];
    const helper = (path: string, pos: number, evaluated: number, multed: number): void => {
      if (pos === num.length) {
        if (target === evaluated) result.push(path);
        return;
      }
      for (let i = pos; i < num.length; ++i) {
        if (i != pos && num[pos] == '0') break;
        const cur = parseInt(num.substring(pos, i + 1));
        if (pos === 0) helper(path + cur, i + 1, cur, cur);
        else {
          helper(path + '+' + cur, i + 1, evaluated + cur, cur);
          helper(path + '-' + cur, i + 1, evaluated - cur, -cur);
          helper(path + '*' + cur, i + 1, evaluated - multed + multed * cur, multed * cur);
        }
      }
    };
    helper('', 0, 0, 0);
    return result;
  },

  'HammingCodes: Integer to Encoded Binary': (data) => hammingEncode(data),

  'HammingCodes: Encoded Binary to Integer': (data) => hammingDecode(data),

  'Proper 2-Coloring of a Graph': (data) => {
    const vertices = data[0];
    const edges = data[1];
    const adj: number[][] = Array.from({ length: vertices }, () => []);
    for (const [a, b] of edges) {
      adj[a].push(b);
      adj[b].push(a);
    }
    const coloring: (0 | 1 | -1)[] = Array<0 | 1 | -1>(vertices).fill(-1);
    for (let start = 0; start < vertices; start++) {
      if (coloring[start] !== -1) continue;
      coloring[start] = 0;
      const frontier: number[] = [start];
      while (frontier.length > 0) {
        const v = frontier.pop() as number;
        for (const u of adj[v]) {
          if (coloring[u] === -1) {
            coloring[u] = coloring[v] === 0 ? 1 : 0;
            frontier.push(u);
          } else if (coloring[u] === coloring[v]) {
            return [];
          }
        }
      }
    }
    return coloring as (0 | 1)[];
  },

  'Compression I: RLE Compression': (data) => {
    if (data.length === 0) return '';
    let out = '';
    let count = 1;
    for (let i = 1; i < data.length; i++) {
      if (count < 9 && data[i] === data[i - 1]) {
        count++;
        continue;
      }
      out += count + data[i - 1];
      count = 1;
    }
    out += count + data[data.length - 1];
    return out;
  },

  'Compression II: LZ Decompression': (data) => lzDecode(data),

  'Compression III: LZ Compression': (data) => lzEncode(data),

  'Encryption I: Caesar Cipher': (data) => {
    return [...data[0]]
      .map((a) => (a === ' ' ? a : String.fromCharCode(((a.charCodeAt(0) - 65 - data[1] + 26) % 26) + 65)))
      .join('');
  },

  'Encryption II: Vigenère Cipher': (data) => {
    const keyword = data[1];
    return [...data[0]]
      .map((a, i) =>
        a === ' '
          ? a
          : String.fromCharCode(((a.charCodeAt(0) - 2 * 65 + keyword.charCodeAt(i % keyword.length)) % 26) + 65),
      )
      .join('');
  },

  'Square Root': (data) => {
    const s = isqrt(data);
    return data - s * s <= s ? s : s + 1n;
  },

  'Total Number of Primes': (data) => {
    let low = data[0];
    const high = data[1];
    if (low < 2) low = 2;
    const simpleSieve = (max: number): number[] => {
      const primes: number[] = [];
      const arr = Array(max);
      for (let i = 2; i * i <= max; i++) {
        if (!arr[i]) for (let p = i * i; p <= max; p += i) arr[p] = 1;
      }
      for (let i = 2; i <= max; i++) if (!arr[i]) primes.push(i);
      return primes;
    };
    let count = 0;
    const arr = Array(high - low + 1);
    const checks = simpleSieve(Math.ceil(Math.sqrt(high)));
    for (const i of checks) {
      const lim = Math.max(i, Math.ceil(low / i)) * i;
      for (let j = lim; j <= high; j += i) arr[j - low] = 1;
    }
    for (let a = 0; a <= high - low; a++) if (!arr[a]) ++count;
    return count;
  },

  'Largest Rectangle in a Matrix': (data) => {
    const histograms = Array.from({ length: data.length }, () => Array<number>(data[0].length).fill(0));
    for (let i = 0; i < data[0].length; i++) {
      let count = 0;
      for (let j = 0; j < data.length; j++) {
        if (data[j][i] == 0) count++;
        else count = 0;
        histograms[j][i] = count;
      }
    }
    let maxArea = 0;
    let maxL = 0;
    let maxR = 0;
    let maxU = 0;
    let maxD = 0;
    for (let i = 0; i < histograms.length; i++) {
      const row = histograms[i];
      for (let j = 0; j < row.length; j++) {
        if (row[j] == 0) continue;
        let left = j;
        let right = j;
        while (row[left - 1] >= row[j]) left--;
        while (row[right + 1] >= row[j]) right++;
        if ((right - left + 1) * row[j] > maxArea) {
          maxArea = (right - left + 1) * row[j];
          maxL = left;
          maxR = right;
          maxU = i - row[j] + 1;
          maxD = i;
        }
      }
    }
    return [
      [maxU, maxL],
      [maxD, maxR],
    ];
  },
};
