/**
 * FSRS 6.0 测试脚本 - 模拟20个句子各6次评分
 */

const FSRS_DEFAULT_PARAMS = {
  w: [
    0.4072, 1.1829, 3.1262, 15.4722, 7.2102, 0.5316, 1.0651, 0.0234, 1.616,
    0.1544, 1.0824, 1.9813, 0.0953, 0.2975, 2.2042, 0.2407, 2.9466, 0.5034,
    0.6567, 0.0005, 1.0
  ],
  requestRetention: 0.9,
  maximumInterval: 36500,
  easyBonus: 1.3,
  hardInterval: 1.2
};

const State = {
  New: 0,
  Learning: 1,
  Review: 2,
  Relearning: 3
};

function constrainDifficulty(d) {
  return Math.min(10, Math.max(1, d));
}

function constrainStability(s) {
  return Math.max(0.01, Math.min(s, 36500));
}

function initStability(r, params) {
  return Math.max(0.01, params.w[r - 1]);
}

function initDifficulty(r, params) {
  return constrainDifficulty(params.w[4] - params.w[5] * (r - 3));
}

function nextDifficulty(d, r, params) {
  const w = params.w;
  const D0_Easy = w[4] - w[5] * (4 - 3);
  const delta = w[6] * (r - 3) * (10 - d) / 9;
  return constrainDifficulty(w[7] * D0_Easy + (1 - w[7]) * (d - delta));
}

function getRetrievability(s, t, params) {
  const S = Math.max(0.01, s);
  const w20 = params.w[20];
  return Math.pow(1 + (19 / 81) * (t / S), -w20);
}

function nextStability(d, s, r, elapsed, sameDay, params) {
  const w = params.w;
  const safeD = constrainDifficulty(d);
  const S = Math.max(0.01, s);
  const R = getRetrievability(S, elapsed, params);

  if (r === 1) {
    const sNew =
      w[11] *
      Math.pow(safeD, -w[12]) *
      (Math.pow(S + 1, w[13]) - 1) *
      Math.exp((1 - R) * w[14]);
    return constrainStability(Math.min(sNew, S / Math.exp(w[17] * w[18])));
  }

  if (sameDay) {
    const mult =
      Math.exp(w[17] * (r - 3 + w[18])) *
      Math.pow(S, -w[19]);
    return constrainStability(S * (r >= 3 ? Math.max(1, mult) : mult));
  }

  const hardPenalty = r === 2 ? w[15] : 1;

  const sNew =
    S *
    (1 +
      Math.exp(w[8]) *
        (11 - safeD) *
        Math.pow(S, -w[9]) *
        (Math.exp((1 - R) * w[10]) - 1) *
        hardPenalty);

  return constrainStability(sNew);
}

function calculateInterval(s, params) {
  const w20 = params.w[20];
  const raw =
    s * (81 / 19) * (Math.pow(params.requestRetention, -1 / w20) - 1);
  return Math.min(Math.max(1, Math.round(raw)), params.maximumInterval);
}

function isSameDay(last, now) {
  if (!last) return false;
  return new Date(last).toDateString() === new Date(now).toDateString();
}

function simulateReview(params) {
  const ratings = [];
  const intervals = [];
  const difficulties = [];
  const stabilities = [];
  
  let card = {
    due: Date.now(),
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: State.New,
    last_review: null
  };

  for (let i = 0; i < 6; i++) {
    const r = Math.floor(Math.random() * 4) + 1;
    ratings.push(r);
    
    const now = Date.now() + i * 86400000;
    const elapsed = card.last_review 
      ? Math.max(0, (now - card.last_review) / 86400000) 
      : 0;
    const sameDay = isSameDay(card.last_review, now);

    if (card.state === State.New) {
      card.difficulty = initDifficulty(r, params);
      card.stability = initStability(r, params);
      card.reps = 1;
      card.last_review = now;

      if (r >= 3) {
        let interval = calculateInterval(card.stability, params);
        card.state = State.Review;
        if (r === 4) {
          interval = Math.round(interval * params.easyBonus);
        }
        card.scheduled_days = interval;
        card.due = now + card.scheduled_days * 86400000;
      } else {
        card.state = State.Learning;
        card.scheduled_days = 0;
        card.due = now + (r === 1 ? 60000 : 600000);
      }
    } else {
      card.difficulty = nextDifficulty(card.difficulty, r, params);

      if (card.state === State.Review) {
        card.stability = nextStability(
          card.difficulty,
          card.stability,
          r,
          elapsed,
          sameDay,
          params
        );
      }

      card.reps += 1;
      if (r === 1) card.lapses += 1;
      card.last_review = now;

      if (r === 1) {
        card.state = State.Relearning;
        card.scheduled_days = 0;
        card.due = now + 60000;
      } else {
        let interval = calculateInterval(card.stability, params);
        card.state = State.Review;
        if (r === 2) {
          interval = Math.max(1, Math.round(interval * params.hardInterval));
        } else if (r === 4) {
          interval = Math.round(interval * params.easyBonus);
        }
        card.scheduled_days = interval;
        card.due = now + card.scheduled_days * 86400000;
      }
    }

    intervals.push(card.scheduled_days);
    difficulties.push(card.difficulty);
    stabilities.push(card.stability);
  }

  return { ratings, intervals, difficulties, stabilities };
}

function getRatingShort(r) {
  const map = { 1: 'A', 2: 'H', 3: 'G', 4: 'E' };
  return map[r];
}

function getRatingName(r) {
  const map = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };
  return map[r];
}

console.log('\n');
console.log('╔' + '═'.repeat(120) + '╗');
console.log('║' + ' '.repeat(40) + 'FSRS 6.0 算法测试报告' + ' '.repeat(40) + '   ║');
console.log('║' + ' '.repeat(35) + '20个句子 × 6次评分 间隔对比表' + ' '.repeat(35) + '   ║');
console.log('╚' + '═'.repeat(120) + '╝');
console.log('\n');

const results = [];
for (let i = 0; i < 20; i++) {
  results.push(simulateReview(FSRS_DEFAULT_PARAMS));
}

const separator = '─'.repeat(116);

console.log('┌' + separator + '┐');
console.log('│ ' + '评分序列'.padEnd(20) + '│ ' + '第1次'.padEnd(8) + '│ ' + '第2次'.padEnd(8) + '│ ' + '第3次'.padEnd(8) + '│ ' + '第4次'.padEnd(8) + '│ ' + '第5次'.padEnd(8) + '│ ' + '第6次'.padEnd(8) + '│ ' + '变化趋势'.padEnd(14) + ' │');
console.log('├' + separator + '┤');

results.forEach((result, index) => {
  const letterRatingStr = result.ratings.map(r => getRatingShort(r)).join(' → ');
  const ratingDisplay = letterRatingStr.padEnd(18);
  
  const firstInterval = result.intervals[0];
  const lastInterval = result.intervals[5];
  const changePercent = firstInterval > 0 
    ? ((lastInterval - firstInterval) / firstInterval * 100).toFixed(0)
    : 0;
  const trend = lastInterval >= firstInterval 
    ? `📈 +${changePercent}%` 
    : `📉 ${changePercent}%`;
  
  console.log('│ ' + ratingDisplay + ' │ ' + 
    result.intervals[0].toString().padEnd(6) + ' │ ' + 
    result.intervals[1].toString().padEnd(6) + ' │ ' + 
    result.intervals[2].toString().padEnd(6) + ' │ ' + 
    result.intervals[3].toString().padEnd(6) + ' │ ' + 
    result.intervals[4].toString().padEnd(6) + ' │ ' + 
    result.intervals[5].toString().padEnd(6) + ' │ ' + 
    trend.padEnd(12) + ' │');
});

console.log('└' + separator + '┘');

console.log('\n');
console.log('┌' + separator + '┐');
console.log('│ ' + '稳定性 (Stability) 变化'.padEnd(114) + ' │');
console.log('├' + separator + '┤');

results.forEach((result, index) => {
  const letterRatingStr = result.ratings.map(r => getRatingShort(r)).join(' → ');
  const stabStr = result.stabilities.map(s => s.toFixed(2)).join(' → ');
  console.log('│ ' + `${letterRatingStr.padEnd(18)}: ${stabStr}`.padEnd(115) + '│');
});

console.log('└' + separator + '┘');

console.log('\n');
console.log('┌' + separator + '┐');
console.log('│ ' + '难度 (Difficulty) 变化'.padEnd(114) + ' │');
console.log('├' + separator + '┤');

results.forEach((result, index) => {
  const letterRatingStr = result.ratings.map(r => getRatingShort(r)).join(' → ');
  const diffStr = result.difficulties.map(d => d.toFixed(2)).join(' → ');
  console.log('│ ' + `${letterRatingStr.padEnd(18)}: ${diffStr}`.padEnd(115) + '│');
});

console.log('└' + separator + '┘');

const ratingCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
results.forEach(result => {
  result.ratings.forEach(r => ratingCounts[r]++);
});
const totalRatings = results.length * 6;

console.log('\n');
console.log('┌' + '─'.repeat(26) + '┬' + '─'.repeat(26) + '┬' + '─'.repeat(26) + '┬' + '─'.repeat(26) + '┐');
console.log('│ ' + 'Again (A) = 1'.padEnd(24) + ' │ ' + 'Hard (H) = 2'.padEnd(24) + ' │ ' + 'Good (G) = 3'.padEnd(24) + ' │ ' + 'Easy (E) = 4'.padEnd(24) + ' │');
console.log('├' + '─'.repeat(26) + '┼' + '─'.repeat(26) + '┼' + '─'.repeat(26) + '┼' + '─'.repeat(26) + '┤');
console.log('│ ' + `${ratingCounts[1]} 次 (${(ratingCounts[1]/totalRatings*100).toFixed(1)}%)`.padEnd(24) + ' │ ' + 
            `${ratingCounts[2]} 次 (${(ratingCounts[2]/totalRatings*100).toFixed(1)}%)`.padEnd(24) + ' │ ' + 
            `${ratingCounts[3]} 次 (${(ratingCounts[3]/totalRatings*100).toFixed(1)}%)`.padEnd(24) + ' │ ' + 
            `${ratingCounts[4]} 次 (${(ratingCounts[4]/totalRatings*100).toFixed(1)}%)`.padEnd(24) + ' │');
console.log('└' + '─'.repeat(26) + '┴' + '─'.repeat(26) + '┴' + '─'.repeat(26) + '┴' + '─'.repeat(26) + '┘');

console.log('\n');
console.log('┌' + separator + '┐');
console.log('│ ' + `总评分次数: ${totalRatings}`.padEnd(114) + ' │');
console.log('│ ' + 'hardInterval = 1.2 (Hard评分间隔缩短20%)'.padEnd(114) + ' │');
console.log('│ ' + 'easyBonus = 1.3 (Easy评分间隔增加30%)'.padEnd(114) + ' │');
console.log('└' + separator + '┘');

console.log('\n');
console.log('┌' + separator + '┐');
console.log('│ ' + '验证：相同评分序列产生相同间隔'.padEnd(114) + ' │');
console.log('└' + separator + '┘');

function simulateReviewWithFixedRatings(fixedRatings, params) {
  const intervals = [];
  const difficulties = [];
  const stabilities = [];
  
  let card = {
    due: Date.now(),
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: State.New,
    last_review: null
  };

  for (let i = 0; i < fixedRatings.length; i++) {
    const r = fixedRatings[i];
    const now = Date.now() + i * 86400000;
    const elapsed = card.last_review 
      ? Math.max(0, (now - card.last_review) / 86400000) 
      : 0;
    const sameDay = isSameDay(card.last_review, now);

    if (card.state === State.New) {
      card.difficulty = initDifficulty(r, params);
      card.stability = initStability(r, params);
      card.reps = 1;
      card.last_review = now;

      if (r >= 3) {
        let interval = calculateInterval(card.stability, params);
        card.state = State.Review;
        if (r === 4) {
          interval = Math.round(interval * params.easyBonus);
        }
        card.scheduled_days = interval;
        card.due = now + card.scheduled_days * 86400000;
      } else {
        card.state = State.Learning;
        card.scheduled_days = 0;
        card.due = now + (r === 1 ? 60000 : 600000);
      }
    } else {
      card.difficulty = nextDifficulty(card.difficulty, r, params);

      if (card.state === State.Review) {
        card.stability = nextStability(
          card.difficulty,
          card.stability,
          r,
          elapsed,
          sameDay,
          params
        );
      }

      card.reps += 1;
      if (r === 1) card.lapses += 1;
      card.last_review = now;

      if (r === 1) {
        card.state = State.Relearning;
        card.scheduled_days = 0;
        card.due = now + 60000;
      } else {
        let interval = calculateInterval(card.stability, params);
        card.state = State.Review;
        if (r === 2) {
          interval = Math.max(1, Math.round(interval * params.hardInterval));
        } else if (r === 4) {
          interval = Math.round(interval * params.easyBonus);
        }
        card.scheduled_days = interval;
        card.due = now + card.scheduled_days * 86400000;
      }
    }

    intervals.push(card.scheduled_days);
    difficulties.push(card.difficulty);
    stabilities.push(card.stability);
  }

  return { intervals, difficulties, stabilities };
}

const testCases = [
  [3, 3, 3, 3, 3, 3],
  [4, 4, 4, 4, 4, 4],
  [2, 2, 2, 2, 2, 2],
  [1, 1, 1, 1, 1, 1]
];

testCases.forEach(ratings => {
  const test1 = simulateReviewWithFixedRatings(ratings, FSRS_DEFAULT_PARAMS);
  const test2 = simulateReviewWithFixedRatings(ratings, FSRS_DEFAULT_PARAMS);
  const letterStr = ratings.map(r => getRatingShort(r)).join(' → ');
  console.log(`\n评分 [${letterStr}]:`);
  console.log(`  间隔: ${test1.intervals.join(' → ')}`);
  console.log(`  确定性: ${test1.intervals.join(',') === test2.intervals.join(',') ? '✅ 一致' : '❌ 不一致'}`);
});
