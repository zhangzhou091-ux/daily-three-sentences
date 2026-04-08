/**
 * FSRS-6 修复版测试脚本
 * 同时显示数字评分和字母评分，避免混淆
 */

// FSRS-6 默认参数（21个参数）
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

function getRatingName(r) {
  switch(r) { case 1: return 'Again'; case 2: return 'Hard'; case 3: return 'Good'; case 4: return 'Easy'; default: return 'Unknown'; }
}

function getRatingShort(r) {
  switch(r) { case 1: return 'A'; case 2: return 'H'; case 3: return 'G'; case 4: return 'E'; default: return '?'; }
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

function simulateSentenceReview(sentenceIndex, ratings) {
  const intervals = [];
  let card = { stability: 0, difficulty: 0, reps: 0, lapses: 0, state: State.New, lastReview: null, nextReview: null, scheduledDays: 0 };

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

  return { sentenceIndex, ratings, finalStability: card.stability, finalDifficulty: card.difficulty, finalInterval: card.scheduledDays, intervals, lapses: card.lapses };
}

function main() {
  console.log('╔' + '═'.repeat(100) + '╗');
  console.log('║' + 'FSRS-6 算法模拟测试 - 20个句子 × 6次评分（修复版）'.padStart(58).padEnd(100) + '║');
  console.log('╚' + '═'.repeat(100) + '╝');

  const results = [];
  const sentenceCount = 20;
  const reviewsPerSentence = 6;

  for (let i = 0; i < sentenceCount; i++) {
    const ratings = generateRandomRatings(reviewsPerSentence);
    results.push(simulateSentenceReview(i, ratings));
  }

  console.log('\n┌' + '─'.repeat(100) + '┐');
  console.log('│' + ' 汇总报告（数字评分=1Again,2Hard,3Good,4Easy） '.padStart(75).padEnd(100) + '│');
  console.log('├' + '─'.repeat(4) + '┬' + '─'.repeat(55) + '┬' + '─'.repeat(12) + '┬' + '─'.repeat(10) + '┬' + '─'.repeat(12) + '┬' + '─'.repeat(6) + '┤');
  console.log('│ 序号 │ 数字评分序列（6次）                         │  最终稳定性  │  最终难度  │  最终间隔   │ 遗忘 │');
  console.log('├' + '─'.repeat(4) + '┼' + '─'.repeat(55) + '┼' + '─'.repeat(12) + '┼' + '─'.repeat(10) + '┼' + '─'.repeat(12) + '┼' + '─'.repeat(6) + '┤');

  for (const result of results) {
    const numRatingStr = result.ratings.join(' → ');
    const letterRatingStr = result.ratings.map(r => getRatingShort(r)).join(' → ');
    console.log(`│ ${(result.sentenceIndex + 1).toString().padStart(2).padEnd(4)} │ ${numRatingStr.padEnd(20)} (${letterRatingStr.padEnd(20)}) │ ${result.finalStability.toFixed(2).toString().padStart(10)}天 │ ${result.finalDifficulty.toFixed(2).padStart(8)} │ ${result.finalInterval.toString().padStart(10)}天 │ ${result.lapses.toString().padStart(4)} │`);
  }

  const avgStability = results.reduce((sum, r) => sum + r.finalStability, 0) / results.length;
  const avgDifficulty = results.reduce((sum, r) => sum + r.finalDifficulty, 0) / results.length;
  const avgInterval = results.reduce((sum, r) => sum + r.finalInterval, 0) / results.length;
  const totalLapses = results.reduce((sum, r) => sum + r.lapses, 0);
  const maxInterval = Math.max(...results.map(r => r.finalInterval));
  const minInterval = Math.min(...results.map(r => r.finalInterval));

  console.log('├' + '─'.repeat(4) + '┴' + '─'.repeat(55) + '┴' + '─'.repeat(12) + '┴' + '─'.repeat(10) + '┴' + '─'.repeat(12) + '┴' + '─'.repeat(6) + '┤');
  console.log(`│ 平均值 │ ${' '.repeat(55)} │ ${avgStability.toFixed(2).toString().padStart(10)}天 │ ${avgDifficulty.toFixed(2).padStart(8)} │ ${avgInterval.toFixed(0).toString().padStart(10)}天 │ ${totalLapses.toString().padStart(4)} │`);
  console.log(`│ 最大值 │ ${' '.repeat(55)} │ ${maxInterval.toString().padStart(10)}天 │            │ ${maxInterval.toString().padStart(10)}天 │      │`);
  console.log(`│ 最小值 │ ${' '.repeat(55)} │ ${minInterval.toString().padStart(10)}天 │            │ ${minInterval.toString().padStart(10)}天 │      │`);
  console.log('└' + '─'.repeat(100) + '┘');

  console.log('\n┌' + '─'.repeat(100) + '┐');
  console.log('│' + ' 间隔变化详情（天数） '.padStart(60).padEnd(100) + '│');
  console.log('├' + '─'.repeat(4) + '┬' + '─'.repeat(8) + '┬' + '─'.repeat(8) + '┬' + '─'.repeat(8) + '┬' + '─'.repeat(8) + '┬' + '─'.repeat(8) + '┬' + '─'.repeat(8) + '┬' + '─'.repeat(20) + '┤');
  console.log('│ 序号 │  第1次  │  第2次  │  第3次  │  第4次  │  第5次  │  第6次  │       变化趋势        │');
  console.log('├' + '─'.repeat(4) + '┼' + '─'.repeat(8) + '┼' + '─'.repeat(8) + '┼' + '─'.repeat(8) + '┼' + '─'.repeat(8) + '┼' + '─'.repeat(8) + '┼' + '─'.repeat(8) + '┼' + '─'.repeat(20) + '┤');

  for (const result of results) {
    const intervals = result.intervals.map(i => i.toString().padStart(6));
    const first = result.intervals[0];
    const last = result.intervals[result.intervals.length - 1];
    const change = ((last - first) / first * 100).toFixed(0);
    let trend = '';
    if (last > first) trend = `📈 +${change}%`;
    else if (last < first) trend = `📉 -${Math.abs(Number(change))}%`;
    else trend = '➡️  0%';
    console.log(`│ ${(result.sentenceIndex + 1).toString().padStart(2).padEnd(2)} │ ${intervals.join(' │ ')} │ ${trend.padEnd(20)} │`);
  }
  console.log('└' + '─'.repeat(100) + '┘');

  console.log('\n┌' + '─'.repeat(100) + '┐');
  console.log('│' + ' 评分分布统计 '.padStart(54).padEnd(100) + '│');
  console.log('├' + '─'.repeat(25) + '┬' + '─'.repeat(25) + '┬' + '─'.repeat(25) + '┬' + '─'.repeat(25) + '┤');
  console.log('│     Again (1)        │     Hard (2)         │     Good (3)         │     Easy (4)         │');
  console.log('├' + '─'.repeat(25) + '┼' + '─'.repeat(25) + '┼' + '─'.repeat(25) + '┼' + '─'.repeat(25) + '┤');

  const ratingCounts = { Again: 0, Hard: 0, Good: 0, Easy: 0 };
  for (const result of results) {
    for (const r of result.ratings) {
      switch(r) {
        case 1: ratingCounts.Again++; break;
        case 2: ratingCounts.Hard++; break;
        case 3: ratingCounts.Good++; break;
        case 4: ratingCounts.Easy++; break;
      }
    }
  }
  const totalRatings = sentenceCount * reviewsPerSentence;
  console.log(`│   ${ratingCounts.Again.toString().padStart(4)} 次 (${(ratingCounts.Again / totalRatings * 100).toFixed(1)}%)   │   ${ratingCounts.Hard.toString().padStart(4)} 次 (${(ratingCounts.Hard / totalRatings * 100).toFixed(1)}%)   │   ${ratingCounts.Good.toString().padStart(4)} 次 (${(ratingCounts.Good / totalRatings * 100).toFixed(1)}%)   │   ${ratingCounts.Easy.toString().padStart(4)} 次 (${(ratingCounts.Easy / totalRatings * 100).toFixed(1)}%)   │`);
  console.log('└' + '─'.repeat(25) + '┴' + '─'.repeat(25) + '┴' + '─'.repeat(25) + '┴' + '─'.repeat(25) + '┘');

  console.log('\n┌' + '─'.repeat(100) + '┐');
  console.log('│  图例: A=Again(忘记)=1  H=Hard(困难)=2  G=Good(良好)=3  E=Easy(简单)=4  │  总评分次数: ' + totalRatings + '  │');
  console.log('└' + '─'.repeat(100) + '┘');

  console.log('\n┌' + '─'.repeat(100) + '┐');
  console.log('│' + ' 验证：相同数字评分序列产生相同间隔 '.padStart(70).padEnd(100) + '│');
  console.log('└' + '─'.repeat(100) + '┘');
  const ratings333333 = [3, 3, 3, 3, 3, 3];
  const test1 = simulateSentenceReview(0, [...ratings333333]);
  const test2 = simulateSentenceReview(0, [...ratings333333]);
  console.log(`\n两次使用相同评分 [3,3,3,3,3,3] 的结果:`);
  console.log(`  测试1: 间隔=${test1.intervals.join(' → ')}, 最终稳定性=${test1.finalStability.toFixed(6)}`);
  console.log(`  测试2: 间隔=${test2.intervals.join(' → ')}, 最终稳定性=${test2.finalStability.toFixed(6)}`);
  console.log(`  结果是否完全一致: ${test1.finalStability === test2.finalStability && test1.intervals.every((v, i) => v === test2.intervals[i]) ? '✅ 是' : '❌ 否'}`);
}

main();
