/**
 * FSRS-6 调试测试
 * 打印所有句子的完整评分序列，检查序号5,11,12,19,20的实际评分
 */

const FSRS_DEFAULT_PARAMS = {
  w: [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001,
      1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014,
      1.8729, 0.5425, 0.0912, 0.0658, 0.1542],
  requestRetention: 0.9,
  maximumInterval: 36500,
  easyBonus: 1.3,
  hardInterval: 1.2
};

const w = FSRS_DEFAULT_PARAMS.w;
const Rating = { Again: 1, Hard: 2, Good: 3, Easy: 4 };
const State = { New: 0, Learning: 1, Review: 2, Relearning: 3 };

function constrainDifficulty(d) { return Math.min(10, Math.max(1, d)); }
function constrainStability(s) { return Math.max(0.1, Math.min(s, 36500)); }
function initStability(r) { return Math.max(0.1, w[r - 1]); }
function initDifficulty(r) { return constrainDifficulty(w[4] - w[5] * (r - 3)); }

function getRetrievability(stability, elapsedDays) {
  if (stability <= 0) return 0.5;
  const safeElapsedDays = Math.max(0, elapsedDays);
  const w20 = w[20];
  const ratio = safeElapsedDays / stability;
  const base = 1 + (19 / 81) * ratio;
  if (base <= 0) return 0.5;
  return Math.max(0, Math.min(1, Math.pow(base, -w20)));
}

function nextDifficulty(d, r) {
  const D0_Easy = w[4] - w[5] * (4 - 3);
  const deltaD = w[6] * (r - 3) * (10 - d) / 9;
  const nextD = d - deltaD;
  return constrainDifficulty(w[7] * D0_Easy + (1 - w[7]) * nextD);
}

function nextStability(d, s, r, elapsedDays = 0) {
  const safeDifficulty = constrainDifficulty(d);
  const safeStability = constrainStability(s);
  const R = getRetrievability(safeStability, elapsedDays);

  if (r === 1) {
    const dPow = Math.pow(Math.max(0.1, safeDifficulty), -Math.max(0.1, w[12]));
    const sPow = Math.pow(Math.max(0.1, safeStability) + 1, Math.max(0.1, w[13]));
    const expVal = Math.exp((1 - R) * w[14]);
    const newStability1 = w[11] * dPow * (sPow - 1) * expVal;
    const constraintVal = safeStability / Math.exp(w[17] * w[18]);
    return constrainStability(Math.min(newStability1, constraintVal));
  }

  if (elapsedDays < 1 && elapsedDays >= 0) {
    const G = r;
    let multiplier;
    if (G >= 3) {
      multiplier = Math.max(1, Math.exp(w[17] * (G - 3 + w[18])) * Math.pow(safeStability, -w[19]));
    } else {
      multiplier = Math.exp(w[17] * (G - 3 + w[18])) * Math.pow(safeStability, -w[19]);
    }
    return constrainStability(safeStability * multiplier);
  }

  const hardPenalty = r === 2 ? w[15] : 1;
  const easyBonus = r === 4 ? FSRS_DEFAULT_PARAMS.easyBonus : 1;
  const expW8 = Math.exp(w[8]);
  const sPowNeg9 = Math.pow(Math.max(0.1, safeStability), -w[9]);
  const expW10 = Math.exp((1 - R) * w[10]);
  const newStability = safeStability * (1 + expW8 * Math.max(1, Math.min(10, 11 - safeDifficulty)) * sPowNeg9 * Math.max(0, expW10 - 1) * hardPenalty * easyBonus);
  return constrainStability(Math.max(0.1, newStability));
}

function calculateInterval(stability) {
  const w20 = w[20];
  const requestRetention = FSRS_DEFAULT_PARAMS.requestRetention;
  const interval = stability * (81 / 19) * (Math.pow(requestRetention, -1 / w20) - 1);
  return Math.min(Math.max(1, Math.round(interval)), FSRS_DEFAULT_PARAMS.maximumInterval);
}

function generateRandomRatings(count = 6) {
  const ratings = [];
  for (let i = 0; i < count; i++) {
    const rand = Math.random();
    if (rand < 0.1) ratings.push(Rating.Again);
    else if (rand < 0.3) ratings.push(Rating.Hard);
    else if (rand < 0.8) ratings.push(Rating.Good);
    else ratings.push(Rating.Easy);
  }
  return ratings;
}

function simulateSentenceReview(ratings) {
  let card = { stability: 0, difficulty: 0, reps: 0, lapses: 0, state: State.New, lastReview: null, nextReview: null, scheduledDays: 0 };
  const intervals = [];

  const firstRating = ratings[0];
  card.stability = initStability(firstRating);
  card.difficulty = initDifficulty(firstRating);
  card.reps = 1;
  card.state = firstRating === Rating.Again || firstRating === Rating.Hard ? State.Learning : State.Review;
  card.scheduledDays = calculateInterval(card.stability);
  intervals.push(card.scheduledDays);

  for (let i = 1; i < ratings.length; i++) {
    const rating = ratings[i];
    const elapsedDays = card.scheduledDays;
    card.difficulty = nextDifficulty(card.difficulty, rating);
    card.stability = nextStability(card.difficulty, card.stability, rating, elapsedDays);

    if (rating === Rating.Again) {
      card.lapses += 1;
      card.state = State.Relearning;
      card.scheduledDays = 0;
    } else {
      let intervalMultiplier = 1;
      if (rating === Rating.Hard) intervalMultiplier = FSRS_DEFAULT_PARAMS.hardInterval;
      else if (rating === Rating.Easy) intervalMultiplier = FSRS_DEFAULT_PARAMS.easyBonus;
      card.scheduledDays = Math.max(1, Math.min(Math.round(calculateInterval(card.stability) * intervalMultiplier), FSRS_DEFAULT_PARAMS.maximumInterval));
      card.state = State.Review;
    }
    card.reps += 1;
    intervals.push(card.scheduledDays);
  }

  return { intervals, finalStability: card.stability, finalDifficulty: card.difficulty };
}

function getRatingShort(r) {
  switch(r) { case 1: return 'A'; case 2: return 'H'; case 3: return 'G'; case 4: return 'E'; default: return '?'; }
}

function getRatingNum(r) {
  switch(r) { case 1: return '1'; case 2: return '2'; case 3: return '3'; case 4: return '4'; default: return '?'; }
}

console.log('FSRS-6 调试测试 - 打印所有句子的完整评分数字序列\n');

const results = [];
const sentenceCount = 20;

for (let i = 0; i < sentenceCount; i++) {
  const ratings = generateRandomRatings(6);
  const result = simulateSentenceReview(ratings);
  results.push({ sentenceIndex: i, ratings, ...result });
}

console.log('序号 | 评分数字序列 (1=Again,2=Hard,3=Good,4=Easy) | 显示的字母序列 | 实际间隔序列');
console.log('---'.repeat(20));

for (const r of results) {
  const numSeq = r.ratings.map(getRatingNum).join(' → ');
  const letterSeq = r.ratings.map(getRatingShort).join(' → ');
  const intSeq = r.intervals.join(' → ');
  console.log(`${(r.sentenceIndex + 1).toString().padStart(2)}   | ${numSeq.padEnd(35)} | ${letterSeq.padEnd(20)} | ${intSeq}`);
}

console.log('\n检查序号 5, 11, 12, 19, 20 的评分序列是否真的是333333:');
const checkIndices = [4, 10, 11, 18, 19];
for (const idx of checkIndices) {
  const r = results[idx];
  const isAllGood = r.ratings.every(rating => rating === Rating.Good);
  console.log(`序号 ${idx + 1}: 评分=${r.ratings.join('')} | 是否全为Good: ${isAllGood ? '✅' : '❌'}`);
}
