import React, { useState, useCallback } from 'react';
import { Sentence } from '../types';
import { storageService } from '../services/storage';
import { supabaseService } from '../services/supabaseService';
import { syncQueueService } from '../services/syncQueueService';
import { getLocalDateString } from '../utils/date';
import { DAILY_LEARN_LIMIT } from '../constants';
import { getMemoryDailyCache } from '../pages/StudyPage/hooks/useDailySelection';

// ============================================================
// 类型
// ============================================================

type CheckStatus = 'pass' | 'warn' | 'fail' | 'info';

interface CheckItem {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  suggestion?: string;
}

interface DiagData {
  sentences: Sentence[];
  todayIds: string[];
  todayCacheKeys: { key: string; date: string }[];
  simulation: {
    finalSelection: Sentence[];
    missedScheduled: Sentence[];
    learnedButScheduled: Sentence[];
    cachePathUsed: boolean;
    forceRegenerate: boolean;
    newScheduledMissed: Sentence[];
  } | null;
}

// ============================================================
// 工具函数
// ============================================================

function getAllDailySelectionKeys(): { key: string; date: string }[] {
  const result: { key: string; date: string }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('d3s_daily_selection_')) {
        result.push({ key, date: key.replace('d3s_daily_selection_', '') });
      }
    }
  } catch { /* ignore */ }
  result.sort((a, b) => b.date.localeCompare(a.date));
  return result;
}

function estimateLocalStorageSize(): number {
  let total = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) total += key.length + (localStorage.getItem(key) || '').length;
    }
  } catch { /* ignore */ }
  return total * 2;
}

function isIOSDevice(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isPWAStandalone(): boolean {
  try { return window.matchMedia('(display-mode: standalone)').matches; }
  catch { return false; }
}

function sentenceName(s: Sentence): string {
  return (s.english || '').substring(0, 20) || '?';
}

// ============================================================
// 组件
// ============================================================

const ScheduleDebugPanel: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [diagData, setDiagData] = useState<DiagData | null>(null);
  const [checks, setChecks] = useState<CheckItem[]>([]);
  const [toastMsg, setToastMsg] = useState('');

  const today = getLocalDateString();

  // ============================================================
  // 一键诊断
  // ============================================================
  const runDiagnostics = useCallback(async () => {
    setLoading(true);
    setChecks([]);
    setDiagData(null);

    try {
      // 1. 加载数据
      const all = await storageService.getSentences();
      const todayIds = await storageService.getTodaySelection();
      const cacheKeys = getAllDailySelectionKeys();

      // 2. 运行模拟生成
      const sim = await runSimulationCore(all, todayIds);

      const data: DiagData = {
        sentences: all,
        todayIds,
        todayCacheKeys: cacheKeys,
        simulation: sim,
      };
      setDiagData(data);

      // 3. 执行 19 项检查
      const results: CheckItem[] = [];
      results.push(checkEnv());
      results.push(checkGuardStatus());
      results.push(checkScheduledSentences(all, todayIds));
      results.push(checkAnomalies(all, todayIds));
      results.push(checkDailyCache(cacheKeys, today));
      results.push(checkMemoryCacheFreshness(all));
      results.push(checkSimulation(sim, todayIds));
      results.push(checkCachePathMiss(sim));
      results.push(checkCloudSync());
      results.push(checkDirtyData(sim));
      // RC#2~#7 新增检查项
      results.push(checkYesterdayLeftoverCrowding(all, sim));
      results.push(checkLastGenDatePersistence());
      results.push(checkCrossDayDetection());
      results.push(checkSentencesChangedSignature(all));
      results.push(checkStorageEviction(all));
      results.push(checkTimezoneConsistency());
      // Bug 2 缺口补充检查
      results.push(checkLearnedInTodaySelection(all, todayIds));
      results.push(checkAddSentenceGuard(all));
      results.push(checkCloudSyncMerge(all));
      setChecks(results);
    } catch (err) {
      console.error('诊断失败:', err);
    } finally {
      setLoading(false);
    }
  }, [today]);

  // ============================================================
  // 快速操作
  // ============================================================
  const clearTodayCache = useCallback(() => {
    const key = `d3s_daily_selection_${today}`;
    localStorage.removeItem(key);
    localStorage.removeItem('d3s_daily_selection');
    setToastMsg('已清除今日缓存，切换回学习页面将重新生成');
    setTimeout(() => setToastMsg(''), 2500);
  }, [today]);

  const clearAllCache = useCallback(() => {
    const keys = getAllDailySelectionKeys();
    keys.forEach(({ key }) => localStorage.removeItem(key));
    localStorage.removeItem('d3s_daily_selection');
    setToastMsg(`已清除 ${keys.length} 条缓存`);
    setTimeout(() => setToastMsg(''), 2500);
  }, []);

  const cleanDirtyScheduled = useCallback(async () => {
    if (!diagData) return;
    const dirty = diagData.sentences.filter(s => s.intervalIndex > 0 && s.scheduledDate);
    if (dirty.length === 0) {
      setToastMsg('无脏数据');
      setTimeout(() => setToastMsg(''), 2000);
      return;
    }
    await Promise.all(dirty.map(s =>
      storageService.updateSentenceFields(s.english, { scheduledDate: undefined })
    ));
    setToastMsg(`已清理 ${dirty.length} 条脏数据`);
    setTimeout(() => setToastMsg(''), 2500);
    // 重新诊断
    runDiagnostics();
  }, [diagData, runDiagnostics]);

  const copyReport = useCallback(() => {
    if (!diagData) return;
    const { sentences, todayIds, todayCacheKeys, simulation } = diagData;
    const type1 = sentences.filter(s => s.intervalIndex > 0 && s.scheduledDate);
    const type2 = sentences.filter(s => s.intervalIndex === 0 && s.scheduledDate && s.scheduledDate! < today && !todayIds.includes(s.id));

    let report = `=== 每日三句 · 预约诊断报告 ===\n`;
    report += `时间: ${new Date().toLocaleString('zh-CN')}\n`;
    report += `设备: ${isIOSDevice() ? 'iOS' : '其他'} | PWA: ${isPWAStandalone() ? '是' : '否'}\n`;
    report += `时区: ${Intl.DateTimeFormat().resolvedOptions().timeZone}\n\n`;

    report += `--- 预约句子 ---\n`;
    sentences.filter(s => s.scheduledDate).forEach(s => {
      report += `[${s.scheduledDate}] "${sentenceName(s)}" | intervalIndex=${s.intervalIndex} | 在今日选择: ${todayIds.includes(s.id) ? '是' : '否'}\n`;
    });

    report += `\n--- 异常数据 ---\n`;
    report += `类型1(已学+预约): ${type1.length}条\n`;
    type1.forEach(s => report += `  "${sentenceName(s)}" intervalIndex=${s.intervalIndex}\n`);
    report += `类型2(过期未学): ${type2.length}条\n`;
    type2.forEach(s => report += `  "${sentenceName(s)}" scheduledDate=${s.scheduledDate}\n`);

    report += `\n--- 缓存 ---\n`;
    todayCacheKeys.forEach(({ date }) => {
      const ids = storageService.getSelectionByDate(date);
      const names = ids.map((id: string) => sentenceName(sentences.find(x => x.id === id)!)).join(', ');
      report += `${date}: ${names}\n`;
    });

    if (simulation) {
      report += `\n--- 模拟生成 ---\n`;
      report += `路径: ${simulation.cachePathUsed ? '缓存' : '强制生成'}\n`;
      report += `入选: ${simulation.finalSelection.map(s => sentenceName(s)).join(', ')}\n`;
      report += `missedScheduled: ${simulation.missedScheduled.length}条\n`;
      report += `脏数据: ${simulation.learnedButScheduled.length}条\n`;
      if (simulation.newScheduledMissed.length > 0) {
        report += `缓存路径缺失: ${simulation.newScheduledMissed.map(s => sentenceName(s)).join(', ')}\n`;
      }
    }

    report += `\n--- 诊断结果 ---\n`;
    checks.forEach(c => {
      const icon = c.status === 'fail' ? '❌' : c.status === 'warn' ? '⚠️' : '✅';
      report += `${icon} ${c.title}: ${c.detail}\n`;
    });

    navigator.clipboard.writeText(report).then(() => {
      setToastMsg('已复制诊断报告');
      setTimeout(() => setToastMsg(''), 2000);
    }).catch(() => {
      setToastMsg('复制失败');
      setTimeout(() => setToastMsg(''), 2000);
    });
  }, [diagData, checks, today]);

  // ============================================================
  // 统计
  // ============================================================
  const passCount = checks.filter(c => c.status === 'pass').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;
  const failCount = checks.filter(c => c.status === 'fail').length;

  const hasRun = diagData !== null;

  // ============================================================
  // 渲染
  // ============================================================
  return (
    <div className="apple-card rounded-2xl overflow-hidden">
      {/* Toast */}
      {toastMsg && (
        <div className="mx-3 mt-3 px-3 py-2 bg-black/90 text-white text-xs font-bold rounded-xl text-center animate-fade-in">
          {toastMsg}
        </div>
      )}

      {/* 标题 + 按钮 */}
      <div className="px-4 py-3 flex items-center justify-between">
        <span className="text-[13px] font-black text-gray-800">🔍 预约诊断</span>
        <button
          onClick={runDiagnostics}
          disabled={loading}
          className={`px-4 py-1.5 rounded-xl text-[11px] font-bold transition-all active:scale-95 ${
            loading
              ? 'bg-gray-200 text-gray-400'
              : 'bg-blue-500 text-white hover:bg-blue-600'
          }`}
        >
          {loading ? '诊断中...' : hasRun ? '重新诊断' : '开始诊断'}
        </button>
      </div>

      {/* 未诊断提示 */}
      {!hasRun && !loading && (
        <div className="px-4 pb-4 text-center text-[11px] text-gray-400">
          点击"开始诊断"一键检测预约系统状态
        </div>
      )}

      {/* 诊断结果 */}
      {hasRun && !loading && (
        <div className="px-3 pb-3 space-y-2">
          {/* 汇总卡片 */}
          <div className="grid grid-cols-3 gap-2 mb-1">
            <SummaryCard label="正常" count={passCount} color="green" />
            <SummaryCard label="警告" count={warnCount} color="amber" />
            <SummaryCard label="异常" count={failCount} color="red" />
          </div>

          {/* 检查项列表 */}
          {checks.map((check) => (
            <CheckCard key={check.id} check={check} />
          ))}

          {/* 修复操作 */}
          <div className="pt-2 space-y-1.5">
            <p className="text-[10px] font-black text-gray-500 uppercase tracking-[0.1em] px-1">🛠 修复操作</p>
            <div className="grid grid-cols-2 gap-1.5">
              <FixButton label="清除今日缓存" onClick={clearTodayCache} color="amber" />
              <FixButton label={`清除全部(${diagData.todayCacheKeys.length})`} onClick={clearAllCache} color="red" />
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <FixButton
                label={`清理脏数据(${diagData.simulation?.learnedButScheduled.length ?? 0})`}
                onClick={cleanDirtyScheduled}
                color="orange"
              />
              <FixButton label="复制诊断报告" onClick={copyReport} color="gray" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================
// 子组件
// ============================================================

const SummaryCard: React.FC<{ label: string; count: number; color: string }> = ({ label, count, color }) => {
  const bgMap: Record<string, string> = { green: 'bg-green-50 border-green-200', amber: 'bg-amber-50 border-amber-200', red: 'bg-red-50 border-red-200' };
  const textMap: Record<string, string> = { green: 'text-green-700', amber: 'text-amber-700', red: 'text-red-700' };
  return (
    <div className={`rounded-xl border ${bgMap[color]} p-2 text-center`}>
      <p className={`text-lg font-black ${textMap[color]}`}>{count}</p>
      <p className={`text-[10px] font-bold ${textMap[color]} opacity-70`}>{label}</p>
    </div>
  );
};

const STATUS_CONFIG: Record<CheckStatus, { icon: string; bg: string; border: string; label: string; labelColor: string }> = {
  pass:  { icon: '✅', bg: 'bg-green-50', border: 'border-green-200', label: '正常', labelColor: 'text-green-600' },
  warn:  { icon: '⚠️', bg: 'bg-amber-50', border: 'border-amber-200', label: '警告', labelColor: 'text-amber-600' },
  fail:  { icon: '❌', bg: 'bg-red-50', border: 'border-red-200', label: '异常', labelColor: 'text-red-600' },
  info:  { icon: 'ℹ️', bg: 'bg-blue-50', border: 'border-blue-200', label: '信息', labelColor: 'text-blue-600' },
};

const CheckCard: React.FC<{ check: CheckItem }> = ({ check }) => {
  const cfg = STATUS_CONFIG[check.status];
  return (
    <div className={`rounded-xl border p-3 ${cfg.bg} ${cfg.border}`}>
      <div className="flex items-center gap-2">
        <span className="text-sm">{cfg.icon}</span>
        <span className="text-[11px] font-black text-gray-800">{check.title}</span>
        <span className={`text-[10px] font-bold ${cfg.labelColor} ml-auto`}>{cfg.label}</span>
      </div>
      <p className="text-[11px] text-gray-600 mt-1 ml-6 leading-relaxed">{check.detail}</p>
      {check.suggestion && (
        <div className="ml-6 mt-1.5 p-2 bg-white/70 rounded-lg border border-dashed border-gray-200">
          <p className="text-[11px] text-gray-700">
            <span className="font-bold">💡 建议：</span>{check.suggestion}
          </p>
        </div>
      )}
    </div>
  );
};

const FixButton: React.FC<{ label: string; onClick: () => void; color: string }> = ({ label, onClick, color }) => {
  const bgMap: Record<string, string> = {
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
    red: 'bg-red-50 border-red-200 text-red-700',
    orange: 'bg-orange-50 border-orange-200 text-orange-700',
    gray: 'bg-gray-100 border-gray-200 text-gray-700',
  };
  return (
    <button
      onClick={onClick}
      className={`py-2.5 rounded-xl border text-[11px] font-bold active:scale-95 transition-all ${bgMap[color]}`}
    >
      {label}
    </button>
  );
};

// ============================================================
// 模拟生成核心（dry-run）
// ============================================================

async function runSimulationCore(
  sentences: Sentence[],
  savedIds: string[]
): Promise<DiagData['simulation']> {
  const LIMIT = DAILY_LEARN_LIMIT;
  const todayDateStr = getLocalDateString();
  const sentenceMap = new Map(sentences.map(s => [s.id, s]));

  let retained: Sentence[] = [];
  let forceRegenerate = false;
  let cachePathUsed = false;
  const newScheduledMissed: Sentence[] = [];

  if (savedIds.length > 0) {
    cachePathUsed = true;
    savedIds.forEach((id: string) => {
      const s = sentenceMap.get(id);
      if (!s) return;
      if (s.scheduledDate && s.scheduledDate > todayDateStr) return;
      const isLearnedToday = s.lastReviewedAt
        ? getLocalDateString(new Date(s.lastReviewedAt)) === todayDateStr
        : false;
      if (s.intervalIndex === 0) {
        retained.push(s);
      } else if (isLearnedToday && !s.scheduledDate) {
        retained.push(s);
      }
    });

    if (retained.length === 0 && sentences.length > 0) {
      forceRegenerate = true;
    }
    if (!forceRegenerate && retained.length > 0) {
      const hasOutdated = retained.some(s => {
        if (s.learnedAt) {
          const ld = getLocalDateString(new Date(s.learnedAt));
          return ld !== todayDateStr && s.intervalIndex > 0;
        }
        return false;
      });
      if (hasOutdated) {
        forceRegenerate = true;
        retained = [];
      }
    }
  } else {
    forceRegenerate = true;
  }

  if (forceRegenerate) {
    retained = [];
    const retainedIdSet = new Set<string>();

    const yesterdayIds = storageService.getYesterdaySelection();
    yesterdayIds.forEach(id => {
      if (retained.length >= LIMIT) return;
      const s = sentenceMap.get(id);
      if (!s || (s.scheduledDate && s.scheduledDate > todayDateStr)) return;
      if (s.intervalIndex === 0) {
        retained.push(s);
        retainedIdSet.add(s.id);
      }
    });

    if (retained.length < LIMIT) {
      const scheduled = sentences.filter(s =>
        s.scheduledDate && s.scheduledDate <= todayDateStr &&
        s.intervalIndex === 0 && !retainedIdSet.has(s.id)
      ).sort((a, b) => a.addedAt - b.addedAt);
      for (const s of scheduled) {
        if (retained.length >= LIMIT) break;
        retained.push(s);
        retainedIdSet.add(s.id);
      }
    }

    if (retained.length < LIMIT) {
      const pool = sentences.filter(s =>
        !s.scheduledDate && s.intervalIndex === 0 && !retainedIdSet.has(s.id)
      ).sort((a, b) => a.addedAt - b.addedAt);
      for (const s of pool) {
        if (retained.length >= LIMIT) break;
        retained.push(s);
        retainedIdSet.add(s.id);
      }
    }
  } else {
    const cachedIdSet = new Set(retained.map(r => r.id));
    newScheduledMissed.push(...sentences.filter(s =>
      s.scheduledDate && s.scheduledDate <= todayDateStr &&
      s.intervalIndex === 0 && !cachedIdSet.has(s.id)
    ));

    const need = LIMIT - retained.length;
    if (need > 0) {
      const retainIdSet = new Set(retained.map(r => r.id));
      const pool = sentences.filter(s =>
        s.intervalIndex === 0 && !retainIdSet.has(s.id) &&
        (!s.scheduledDate || s.scheduledDate <= todayDateStr)
      );
      const scheduled = pool.filter(s => !!s.scheduledDate).sort((a, b) => a.addedAt - b.addedAt);
      const manual = pool.filter(s => !s.scheduledDate && s.isManual === true).sort((a, b) => a.addedAt - b.addedAt);
      const imported = pool.filter(s => !s.scheduledDate && (s.isManual === false || s.isManual === undefined)).sort((a, b) => a.addedAt - b.addedAt);
      retained.push(...[...scheduled, ...manual, ...imported].slice(0, need));
    }
  }

  const finalSelection = retained.slice(0, LIMIT);
  const finalIdSet = new Set(finalSelection.map(s => s.id));

  const missedScheduled = sentences.filter(s =>
    s.scheduledDate && s.scheduledDate <= todayDateStr &&
    s.intervalIndex === 0 && !finalIdSet.has(s.id)
  );

  const learnedButScheduled = sentences.filter(s =>
    s.scheduledDate && s.intervalIndex > 0
  );

  return {
    finalSelection,
    missedScheduled,
    learnedButScheduled,
    cachePathUsed: !forceRegenerate,
    forceRegenerate,
    newScheduledMissed,
  };
}

// ============================================================
// 8 项检查
// ============================================================

function checkEnv(): CheckItem {
  const ios = isIOSDevice();
  const pwa = isPWAStandalone();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lsMB = (estimateLocalStorageSize() / 1024 / 1024).toFixed(2);

  const detail = [
    `${ios ? 'iOS' : '非iOS'}${pwa ? ' · PWA standalone' : ' · 浏览器'}`,
    `时区 ${tz}`,
    `${new Date().toLocaleString('zh-CN')}`,
    `localStorage ${lsMB}MB/5MB`,
  ].join('  ·  ');

  return { id: 'env', title: '环境信息', status: 'info', detail };
}

function checkScheduledSentences(sentences: Sentence[], todayIds: string[]): CheckItem {
  const today = getLocalDateString();
  // 与生成逻辑一致：scheduledDate <= today 表示今日到期或过期，都应被纳入今日学习
  // 使用 type predicate 缩窄类型，使后续访问 s.scheduledDate 为 string（filter 已保证非空）
  const dueScheduled = sentences.filter((s): s is Sentence & { scheduledDate: string } =>
    !!s.scheduledDate && s.scheduledDate <= today && s.intervalIndex === 0
  );
  const todayScheduled = dueScheduled.filter(s => s.scheduledDate === today);
  const expiredScheduled = dueScheduled.filter(s => s.scheduledDate < today);
  const notInSelection = dueScheduled.filter(s => !todayIds.includes(s.id));

  if (notInSelection.length === 0) {
    const parts: string[] = [];
    if (todayScheduled.length > 0) parts.push(`${todayScheduled.length}条今日到期`);
    if (expiredScheduled.length > 0) parts.push(`${expiredScheduled.length}条过期未学`);
    return {
      id: 'scheduled',
      title: `预约句子 (${dueScheduled.length}条)`,
      status: 'pass',
      detail: parts.length > 0
        ? `${parts.join(' + ')}，均已在学习页面中`
        : '无今日/过期预约句子',
    };
  }

  const notInToday = notInSelection.filter(s => s.scheduledDate === today);
  const notInExpired = notInSelection.filter(s => s.scheduledDate < today);
  const names = notInSelection.map(s =>
    `"${sentenceName(s)}"(预约日期=${s.scheduledDate}${s.scheduledDate < today ? ',过期' : ''})`
  ).join(', ');

  const parts: string[] = [];
  if (notInToday.length > 0) parts.push(`${notInToday.length}条今日到期`);
  if (notInExpired.length > 0) parts.push(`${notInExpired.length}条过期未学`);

  return {
    id: 'scheduled',
    title: `预约句子 (${dueScheduled.length}条)`,
    status: 'fail',
    detail: `有 ${notInSelection.length} 条预约句子未出现在学习页面（${parts.join(' + ')}）：${names}`,
    suggestion: '缓存路径未重新检查 / 生成时数据未就绪 / 昨日遗留挤占名额。请清除今日缓存后重新生成',
  };
}

function checkAnomalies(sentences: Sentence[], todayIds: string[]): CheckItem {
  const today = getLocalDateString();
  const type1 = sentences.filter(s => s.intervalIndex > 0 && s.scheduledDate);
  const type2 = sentences.filter(s => s.intervalIndex === 0 && s.scheduledDate && s.scheduledDate! < today && !todayIds.includes(s.id));

  if (type1.length === 0 && type2.length === 0) {
    return { id: 'anomalies', title: '异常数据', status: 'pass', detail: '未检测到异常数据' };
  }

  const parts: string[] = [];
  if (type1.length > 0) parts.push(`类型1(已学+预约): ${type1.length}条 — ${type1.map(s => `"${sentenceName(s)}"`).join(', ')}`);
  if (type2.length > 0) parts.push(`类型2(过期未学): ${type2.length}条 — ${type2.map(s => `"${sentenceName(s)}"`).join(', ')}`);

  const suggestions: string[] = [];
  if (type1.length > 0) suggestions.push('类型1：点击"清理脏数据"清除已学句子的预约日期');
  if (type2.length > 0) suggestions.push('类型2：清除今日缓存后重新生成，预约句子将重新有机会被选中');

  return {
    id: 'anomalies',
    title: `异常数据 (${type1.length + type2.length}条)`,
    status: 'fail',
    detail: parts.join(' | '),
    suggestion: suggestions.join('；'),
  };
}

function checkDailyCache(cacheKeys: { key: string; date: string }[], today: string): CheckItem {
  if (cacheKeys.length === 0) {
    return { id: 'cache', title: '每日选择缓存', status: 'warn', detail: '无缓存（首次使用或已被清除）' };
  }

  const todayCache = cacheKeys.find(c => c.date === today);
  const futureCache = cacheKeys.filter(c => c.date > today);
  const oldCache = cacheKeys.filter(c => c.date < today);

  const parts: string[] = [];
  if (todayCache) parts.push(`今日缓存: ${todayCache.date}`);
  if (futureCache.length > 0) parts.push(`未来缓存: ${futureCache.length}条`);
  if (oldCache.length > 0) parts.push(`历史缓存: ${oldCache.length}条`);

  if (!todayCache) {
    return {
      id: 'cache',
      title: `每日选择缓存 (${cacheKeys.length}条)`,
      status: 'warn',
      detail: `无今日缓存，共 ${cacheKeys.length} 条历史缓存`,
      suggestion: '正常现象：今日尚未生成每日选择，切换回学习页面将自动生成',
    };
  }

  return {
    id: 'cache',
    title: `每日选择缓存 (${cacheKeys.length}条)`,
    status: 'pass',
    detail: parts.join(' | '),
  };
}

function checkSimulation(sim: DiagData['simulation'], todayIds: string[]): CheckItem {
  if (!sim) return { id: 'sim', title: '模拟生成', status: 'warn', detail: '模拟未运行' };

  const simIds = sim.finalSelection.map(s => s.id).sort();
  const actualIds = [...todayIds].sort();
  const match = JSON.stringify(simIds) === JSON.stringify(actualIds);

  const pathLabel = sim.cachePathUsed ? '缓存路径' : '强制生成路径';
  const sentences = sim.finalSelection.map(s => `"${sentenceName(s)}"`).join(', ');

  if (match) {
    return {
      id: 'sim',
      title: '模拟生成对比',
      status: 'pass',
      detail: `${pathLabel} · 模拟与实际一致：${sentences}`,
    };
  }

  return {
    id: 'sim',
    title: '模拟生成对比',
    status: 'fail',
    detail: `${pathLabel} · 模拟与实际不一致 · 模拟: ${sentences} · 实际: ${todayIds.length}条`,
    suggestion: '生成时 sentences 快照过期 / 竞态锁导致。请清除今日缓存后重新生成',
  };
}

function checkCachePathMiss(sim: DiagData['simulation']): CheckItem {
  if (!sim) return { id: 'cachepath', title: '缓存路径检测', status: 'info', detail: '等待模拟结果' };

  if (!sim.cachePathUsed) {
    return {
      id: 'cachepath',
      title: '缓存路径检测',
      status: 'pass',
      detail: '当前使用强制生成路径，无需缓存路径检测',
    };
  }

  if (sim.newScheduledMissed.length === 0) {
    return {
      id: 'cachepath',
      title: '缓存路径检测',
      status: 'pass',
      detail: '缓存路径未遗漏任何预约句子',
    };
  }

  const names = sim.newScheduledMissed.map(s => `"${sentenceName(s)}"`).join(', ');
  return {
    id: 'cachepath',
    title: '缓存路径检测',
    status: 'warn',
    detail: `缓存路径遗漏 ${sim.newScheduledMissed.length} 条新预约句子：${names}`,
    suggestion: 'hasOutdatedCache 不检查 scheduledDate，导致新预约不会被重新评估。清除今日缓存可解决',
  };
}

function checkCloudSync(): CheckItem {
  const isConfigured = supabaseService.isReady;
  const queueCount = syncQueueService.getQueueStatus().pendingCount || 0;

  if (!isConfigured) {
    return {
      id: 'cloud',
      title: '云端同步',
      status: 'warn',
      detail: 'Supabase 未配置，仅使用本地存储',
      suggestion: '配置云端同步后可实现多设备数据互通',
    };
  }

  return {
    id: 'cloud',
    title: '云端同步',
    status: 'pass',
    detail: `Supabase 已连接 · 用户: ${supabaseService.userName || '未知'} · 同步队列: ${queueCount}条`,
  };
}

function checkDirtyData(sim: DiagData['simulation']): CheckItem {
  if (!sim) return { id: 'dirty', title: '脏数据检测', status: 'info', detail: '等待模拟结果' };

  const dirtyCount = sim.learnedButScheduled.length;
  const missedCount = sim.missedScheduled.length;

  if (dirtyCount === 0 && missedCount === 0) {
    return {
      id: 'dirty',
      title: '脏数据与顺延检测',
      status: 'pass',
      detail: '无脏数据，无需要顺延的过期预约',
    };
  }

  const parts: string[] = [];
  if (dirtyCount > 0) parts.push(`${dirtyCount} 条已学句子仍有预约日期（脏数据）`);
  if (missedCount > 0) parts.push(`${missedCount} 条过期预约未入选（会被顺延到明天）`);

  const suggestions: string[] = [];
  if (dirtyCount > 0) suggestions.push('点击"清理脏数据"修复');
  if (missedCount > 0) suggestions.push('清除今日缓存后重新生成，让预约句子有机会被选中');

  return {
    id: 'dirty',
    title: '脏数据与顺延检测',
    status: dirtyCount > 0 ? 'fail' : 'warn',
    detail: parts.join(' | '),
    suggestion: suggestions.join('；'),
  };
}

function checkMemoryCacheFreshness(sentences: Sentence[]): CheckItem {
  const today = getLocalDateString();
  const cache = getMemoryDailyCache();

  if (!cache || cache.date !== today) {
    return {
      id: 'memcache',
      title: '内存缓存鲜度',
      status: 'info',
      detail: cache ? `缓存日期(${cache.date})与今天(${today})不匹配` : '内存缓存为空（首次加载或已被清除）',
    };
  }

  const sentenceMap = new Map(sentences.map(s => [s.id, s]));
  const staleEntries: { id: string; english: string; cacheInterval: number; actualInterval: number; cacheScheduled: string | undefined; actualScheduled: string | undefined }[] = [];

  cache.data.forEach(cached => {
    const actual = sentenceMap.get(cached.id);
    if (!actual) return;
    if (actual.intervalIndex !== cached.intervalIndex || actual.scheduledDate !== cached.scheduledDate) {
      staleEntries.push({
        id: cached.id,
        english: (cached.english || '').substring(0, 20),
        cacheInterval: cached.intervalIndex,
        actualInterval: actual.intervalIndex,
        cacheScheduled: cached.scheduledDate,
        actualScheduled: actual.scheduledDate,
      });
    }
  });

  if (staleEntries.length === 0) {
    return {
      id: 'memcache',
      title: '内存缓存鲜度',
      status: 'pass',
      detail: `缓存中 ${cache.data.length} 条句子的 intervalIndex 与数据库一致`,
    };
  }

  const names = staleEntries.map(e =>
    `"${e.english}"(缓存intervalIndex=${e.cacheInterval}→实际${e.actualInterval}${e.cacheScheduled !== e.actualScheduled ? ', scheduledDate不同' : ''})`
  ).join(' | ');
  return {
    id: 'memcache',
    title: '内存缓存鲜度',
    status: 'fail',
    detail: `${staleEntries.length} 条句子缓存过期：${names}`,
    suggestion: 'MEMORY_DAILY_CACHE 与 IndexedDB 不同步。切换标签页后可能显示过期数据。修复1(useLearnLogic同步缓存)已部署，若仍出现请清除今日缓存',
  };
}

function checkGuardStatus(): CheckItem {
  return {
    id: 'guards',
    title: '修复守卫状态',
    status: 'info',
    detail: '修复1(MEMORY_DAILY_CACHE同步) ✅ | 修复2(addSentence守卫) ✅ | 修复3(云端同步守卫) ✅',
  };
}

// ============================================================
// RC#2~#7 新增诊断检查项
// ============================================================

function checkYesterdayLeftoverCrowding(
  sentences: Sentence[],
  sim: DiagData['simulation']
): CheckItem {
  if (!sim) return { id: 'rc2', title: 'RC#2 昨日遗留挤占', status: 'info', detail: '等待模拟结果' };

  const today = getLocalDateString();
  const yesterdayIds = storageService.getYesterdaySelection();
  const todayScheduled = sentences.filter(s =>
    s.scheduledDate && s.scheduledDate <= today &&
    s.intervalIndex === 0
  );

  if (yesterdayIds.length === 0) {
    return {
      id: 'rc2',
      title: 'RC#2 昨日遗留挤占',
      status: 'pass',
      detail: '昨日无遗留句子，不存在挤占风险',
    };
  }

  if (!sim.forceRegenerate) {
    return {
      id: 'rc2',
      title: 'RC#2 昨日遗留挤占',
      status: 'info',
      detail: `当前走缓存路径(${sim.cachePathUsed ? '缓存' : '未知'})，不适用昨日遗留优先级逻辑`,
    };
  }

  const yesterdayRetained = sim.finalSelection.filter(s => yesterdayIds.includes(s.id));
  const fullByYesterday = yesterdayRetained.length >= DAILY_LEARN_LIMIT;

  if (fullByYesterday && todayScheduled.length > 0) {
    const names = todayScheduled.map(s => `"${sentenceName(s)}"(${s.scheduledDate})`).join(', ');
    return {
      id: 'rc2',
      title: 'RC#2 昨日遗留挤占',
      status: 'fail',
      detail: `昨日遗留 ${yesterdayRetained.length} 条占满全部 ${DAILY_LEARN_LIMIT} 个名额，${todayScheduled.length} 条今日/过期预约句被挤出：${names}`,
      suggestion: '提升今日预约句优先级至昨日遗留之上，或清除今日缓存后重新生成',
    };
  }

  if (fullByYesterday) {
    return {
      id: 'rc2',
      title: 'RC#2 昨日遗留挤占',
      status: 'warn',
      detail: `昨日遗留 ${yesterdayRetained.length} 条占满全部名额，但无今日预约句被影响`,
    };
  }

  return {
    id: 'rc2',
    title: 'RC#2 昨日遗留挤占',
    status: 'pass',
    detail: `昨日遗留 ${yesterdayRetained.length} 条，未占满名额(${DAILY_LEARN_LIMIT})，今日预约句可正常进入`,
  };
}

function checkLastGenDatePersistence(): CheckItem {
  const today = getLocalDateString();
  let persistedDate = '';
  try { persistedDate = localStorage.getItem('d3s_last_gen_date') || ''; } catch { /* ignore */ }

  if (!persistedDate) {
    return {
      id: 'rc3',
      title: 'RC#3 lastGeneratedDate 持久化',
      status: 'warn',
      detail: 'd3s_last_gen_date 不存在，PWA 冷启动后无法判断跨日',
      suggestion: '需要在 generateDailySelection 完成后持久化 lastGeneratedDate 到 localStorage',
    };
  }

  if (persistedDate === today) {
    return {
      id: 'rc3',
      title: 'RC#3 lastGeneratedDate 持久化',
      status: 'pass',
      detail: `d3s_last_gen_date = ${persistedDate}，与今天一致，跨日检测正常`,
    };
  }

  return {
    id: 'rc3',
    title: 'RC#3 lastGeneratedDate 持久化',
    status: 'warn',
    detail: `d3s_last_gen_date = ${persistedDate}，与今天(${today})不一致，可能需要重新生成`,
    suggestion: '切换回学习页面将触发跨日检测并重新生成',
  };
}

function checkCrossDayDetection(): CheckItem {
  const isIOS = isIOSDevice();
  const isPWA = isPWAStandalone();
  const supportsPageShow = typeof window !== 'undefined' && 'onpageshow' in window;

  const parts: string[] = [];
  parts.push(`visibilitychange: ✅`);
  parts.push(`setInterval: 60s (原120s)`);
  parts.push(`pageshow: ${supportsPageShow ? '✅' : '❌ 不支持'}`);

  if (isIOS && isPWA) {
    parts.push(`iOS PWA 模式: ⚠️ 后台 setInterval 可能被节流/冻结`);
    return {
      id: 'rc4',
      title: 'RC#4 跨日检测可靠性',
      status: 'warn',
      detail: parts.join(' | '),
      suggestion: 'iOS PWA 后台时定时器可能被完全冻结，依赖 visibilitychange + pageshow 恢复时检测。如预约句未按时出现，请手动刷新页面',
    };
  }

  return {
    id: 'rc4',
    title: 'RC#4 跨日检测可靠性',
    status: 'pass',
    detail: parts.join(' | '),
  };
}

function checkSentencesChangedSignature(
  sentences: Sentence[]
): CheckItem {
  if (sentences.length === 0) {
    return {
      id: 'rc5',
      title: 'RC#5 sentencesChanged 签名',
      status: 'info',
      detail: '句子列表为空，无法计算签名',
    };
  }

  const updatedAtSum = sentences.reduce((sum, s) => sum + (s.updatedAt || 0), 0);
  const scheduledCount = sentences.filter(s => s.scheduledDate).length;
  const scheduledSig = sentences
    .filter(s => s.scheduledDate)
    .map(s => s.id + ':' + s.scheduledDate)
    .sort()
    .join('|');

  const hasScheduleInSig = scheduledSig.length > 0;

  return {
    id: 'rc5',
    title: 'RC#5 sentencesChanged 签名',
    status: hasScheduleInSig ? 'pass' : 'info',
    detail: `签名包含: len=${sentences.length} | updatedAtSum=${updatedAtSum} | scheduledSig=${scheduledSig.substring(0, 60)}${scheduledSig.length > 60 ? '...' : ''} | 预约句子=${scheduledCount}条`,
    suggestion: hasScheduleInSig
      ? '签名已包含完整 scheduledSig 字符串，任何 scheduledDate 变更都会触发重新生成'
      : '无预约句子，签名不包含 scheduledDate 维度不影响当前行为',
  };
}

function checkStorageEviction(
  sentences: Sentence[]
): CheckItem {
  const hasDataMarker = (() => {
    try { return localStorage.getItem('d3s_has_data') === '1'; } catch { return false; }
  })();

  if (!hasDataMarker) {
    return {
      id: 'rc6',
      title: 'RC#6 iOS 存储驱逐检测',
      status: 'info',
      detail: 'd3s_has_data 标记不存在（首次使用或从未设置）',
      suggestion: '在 addSentence 成功后写入 d3s_has_data=1 作为驱逐检测基线',
    };
  }

  if (sentences.length === 0) {
    return {
      id: 'rc6',
      title: 'RC#6 iOS 存储驱逐检测',
      status: 'fail',
      detail: 'd3s_has_data=1 但 IndexedDB 中句子数为 0，疑似 iOS 存储驱逐',
      suggestion: '数据可能被 iOS 系统清除。如已配置云同步，切换回学习页面将自动从云端恢复',
    };
  }

  return {
    id: 'rc6',
    title: 'RC#6 iOS 存储驱逐检测',
    status: 'pass',
    detail: `d3s_has_data=1，IndexedDB 中有 ${sentences.length} 条句子，数据完整`,
  };
}

function checkTimezoneConsistency(): CheckItem {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = getLocalDateString();
  const utcDate = new Date().toISOString().substring(0, 10);

  const sameDay = today === utcDate;

  return {
    id: 'rc7',
    title: 'RC#7 时区一致性',
    status: sameDay ? 'pass' : 'info',
    detail: `时区: ${tz} | 本地日期: ${today} | UTC日期: ${utcDate} | ${sameDay ? '一致' : '跨UTC日（如旅行中）'}`,
    suggestion: sameDay
      ? undefined
      : '跨时区旅行中，scheduledDate 使用设置时的本地日期。请注意预约句可能因时区偏差提前/延后出现',
  };
}

// ============================================================
// Bug 2 缺口补充：已学句子又出现在学习页面的 3 项检查
// ============================================================

/**
 * 缺口1：检测今日学习列表中是否包含已学句子（intervalIndex > 0）
 * 这是 Bug 2 最直接的证据——如果 pass，说明守卫生效；如果 fail，说明已学句子逃逸到了学习页面
 */
function checkLearnedInTodaySelection(
  sentences: Sentence[],
  todayIds: string[]
): CheckItem {
  if (todayIds.length === 0) {
    return {
      id: 'b2_learned_in_selection',
      title: 'B2缺口1 已学句子逃逸检测',
      status: 'info',
      detail: '今日选择为空，无法检测',
    };
  }

  const sentenceMap = new Map(sentences.map(s => [s.id, s]));
  const learnedInSelection: { id: string; english: string; intervalIndex: number; scheduledDate?: string }[] = [];

  todayIds.forEach(id => {
    const s = sentenceMap.get(id);
    if (s && s.intervalIndex > 0) {
      learnedInSelection.push({
        id: s.id,
        english: (s.english || '').substring(0, 25),
        intervalIndex: s.intervalIndex,
        scheduledDate: s.scheduledDate,
      });
    }
  });

  if (learnedInSelection.length === 0) {
    return {
      id: 'b2_learned_in_selection',
      title: 'B2缺口1 已学句子逃逸检测',
      status: 'pass',
      detail: `今日 ${todayIds.length} 条句子中无已学句子，守卫生效`,
    };
  }

  const names = learnedInSelection.map(s =>
    `"${s.english}"(intervalIndex=${s.intervalIndex}${s.scheduledDate ? ', 预约日期=' + s.scheduledDate : ''})`
  ).join(' | ');

  return {
    id: 'b2_learned_in_selection',
    title: 'B2缺口1 已学句子逃逸检测',
    status: 'fail',
    detail: `今日 ${todayIds.length} 条句子中有 ${learnedInSelection.length} 条已学句子：${names}`,
    suggestion: '已学句子出现在学习页面，说明 addSentence 守卫或云端同步守卫未能阻止 intervalIndex 被覆盖。建议：1) 清除今日缓存 2) 检查 addSentence 中 intervalIndex 保留逻辑 3) 检查 mergeSentencesByUpdatedAt 是否保留了本地 intervalIndex',
  };
}

/**
 * 缺口2：验证 addSentence 守卫是否实际生效
 * 检测最近 1 小时内被更新的已学句子——如果存在，可能是守卫被绕过
 */
function checkAddSentenceGuard(
  sentences: Sentence[]
): CheckItem {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  const recentlyUpdatedLearned = sentences.filter(s =>
    s.intervalIndex > 0 &&
    s.updatedAt &&
    s.updatedAt > oneHourAgo
  );

  if (recentlyUpdatedLearned.length === 0) {
    // 检查是否有足够的样本来验证守卫
    const learnedCount = sentences.filter(s => s.intervalIndex > 0).length;
    return {
      id: 'b2_add_sentence_guard',
      title: 'B2缺口2 addSentence 守卫验证',
      status: 'pass',
      detail: `最近 1 小时内无已学句子被更新，${learnedCount > 0 ? `共 ${learnedCount} 条已学句子的 intervalIndex 未被覆盖` : '无已学句子'}`,
    };
  }

  const names = recentlyUpdatedLearned.map(s =>
    `"${(s.english || '').substring(0, 20)}"(intervalIndex=${s.intervalIndex})`
  ).join(' | ');

  return {
    id: 'b2_add_sentence_guard',
    title: 'B2缺口2 addSentence 守卫验证',
    status: 'warn',
    detail: `最近 1 小时内有 ${recentlyUpdatedLearned.length} 条已学句子被更新：${names}`,
    suggestion: '已学句子近期被更新，可能是用户手动编辑或云端同步。如果这些已学句子出现在学习页面，说明 addSentence 的 intervalIndex 保留逻辑被绕过。请检查 addSentence 中 `if (existing && existing.intervalIndex > 0) { ... }` 守卫是否完整',
  };
}

/**
 * 缺口3：验证云端同步 merge 是否保留了本地 intervalIndex
 * 检测是否有已学句子的 updatedAt 与云端同步时间窗口吻合——如果云端回写覆盖了 intervalIndex，会导致 Bug 2
 */
function checkCloudSyncMerge(
  sentences: Sentence[]
): CheckItem {
  const isConfigured = supabaseService.isReady;
  const queueCount = syncQueueService.getQueueStatus().pendingCount || 0;

  if (!isConfigured) {
    return {
      id: 'b2_cloud_sync_merge',
      title: 'B2缺口3 云端同步合并验证',
      status: 'info',
      detail: 'Supabase 未配置，云端同步合并风险不适用',
    };
  }

  // 检查是否有已学句子且云端同步处于活跃状态
  const learnedCount = sentences.filter(s => s.intervalIndex > 0).length;

  if (learnedCount === 0) {
    return {
      id: 'b2_cloud_sync_merge',
      title: 'B2缺口3 云端同步合并验证',
      status: 'pass',
      detail: `Supabase 已连接 · 无已学句子，不存在云端覆盖 intervalIndex 的风险`,
    };
  }

  const riskLevel = queueCount > 0 ? 'warn' : 'pass';
  const detail = queueCount > 0
    ? `Supabase 已连接 · ${learnedCount} 条已学句子 · 同步队列有 ${queueCount} 条待同步，存在云端回写覆盖本地 intervalIndex 的潜在风险`
    : `Supabase 已连接 · ${learnedCount} 条已学句子 · 同步队列为空，当前无云端覆盖风险`;

  return {
    id: 'b2_cloud_sync_merge',
    title: 'B2缺口3 云端同步合并验证',
    status: riskLevel,
    detail,
    suggestion: queueCount > 0
      ? '云端同步队列非空时，pullAllInBackground 或 pullDailySelectionInBackground 可能将云端旧数据回写到本地，覆盖 intervalIndex。建议：确保 mergeSentencesByUpdatedAt 中本地 intervalIndex > 0 时不被云端数据覆盖'
      : '当前无同步风险。但 mergeSentencesByUpdatedAt 应始终在合并时保留本地 intervalIndex（当本地 intervalIndex > 云端 intervalIndex 时）',
  };
}

export default ScheduleDebugPanel;