import { Sentence, UserStats } from '../../types';
import { TimePeriodStats } from './timeStats';
import { TrendData } from './dataStats';
import { ScheduleEvent } from '../schedule/scheduleService';

const formatDate = (timestamp: number): string => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
};

const formatDateTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  return `${formatDate(timestamp)} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
};

export interface ExportData {
  sentences: Sentence[];
  stats: UserStats;
  timeStats: {
    weekly: TimePeriodStats;
    monthly: TimePeriodStats;
    yearly: TimePeriodStats;
    allTime: TimePeriodStats;
  };
  events: ScheduleEvent[];
  trends: TrendData[];
}

export const exportToCSV = (data: ExportData, filename: string = 'export'): void => {
  const rows: string[][] = [];
  
  rows.push(['=== 数据统计导出 ===']);
  rows.push([]);
  
  rows.push(['=== 句子数据 ===']);
  rows.push(['ID', '英文', '中文', '标签', '添加时间', '学习时间', '复习次数', '稳定性', '难度', '间隔']);
  data.sentences.forEach(s => {
    rows.push([
      s.id,
      `"${(s.english || '').replace(/"/g, '""')}"`,
      `"${(s.chinese || '').replace(/"/g, '""')}"`,
      `"${(s.tags || []).join(', ')}"`,
      s.addedAt ? formatDate(s.addedAt) : '',
      s.learnedAt ? formatDate(s.learnedAt) : '',
      String(s.reps || 0),
      String(s.stability || 0),
      String(s.difficulty || 0),
      String(s.intervalIndex || 0),
    ]);
  });
  
  rows.push([]);
  rows.push(['=== 时间维度统计 ===']);
  rows.push(['维度', '新增句子', '复习次数', '默写次数', '获得积分', '记忆保持', '学习天数', '完成率']);
  const timeStatsEntries = [
    { key: 'weekly', label: '本周' },
    { key: 'monthly', label: '本月' },
    { key: 'yearly', label: '本年' },
    { key: 'allTime', label: '累计' },
  ] as const;
  
  timeStatsEntries.forEach(({ key, label }) => {
    const stat = data.timeStats[key];
    rows.push([
      label,
      String(stat.newSentences),
      String(stat.reviewsCompleted),
      String(stat.dictationsCompleted),
      String(stat.pointsEarned),
      `${stat.avgRetention}%`,
      String(stat.streakDays),
      `${stat.completionRate}%`,
    ]);
  });
  
  rows.push([]);
  rows.push(['=== 用户统计 ===']);
  rows.push(['指标', '值']);
  rows.push(['连续学习天数', String(data.stats.streak || 0)]);
  rows.push(['累计积分', String(data.stats.totalPoints || 0)]);
  rows.push(['默写次数', String(data.stats.dictationCount || 0)]);
  rows.push(['总学习天数', String(data.stats.totalDaysLearned || 0)]);
  rows.push(['最高连续天数', String(data.stats.maxStreak || 0)]);
  
  rows.push([]);
  rows.push(['=== 日程事件 ===']);
  rows.push(['ID', '标题', '描述', '开始时间', '结束时间', '颜色', '重复', '已完成']);
  data.events.forEach(e => {
    rows.push([
      e.id,
      `"${(e.title || '').replace(/"/g, '""')}"`,
      `"${(e.description || '').replace(/"/g, '""')}"`,
      formatDateTime(e.start),
      formatDateTime(e.end),
      e.color,
      e.repeat?.type || 'none',
      e.completed ? '是' : '否',
    ]);
  });
  
  const csvContent = rows.map(row => row.join(',')).join('\n');
  const BOM = '\uFEFF';
  const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, `${filename}.csv`);
};

export const exportToExcel = (data: ExportData, filename: string = 'export'): void => {
  const sheets: { name: string; rows: (string | number)[][] }[] = [];
  
  sheets.push({
    name: '句子数据',
    rows: [
      ['ID', '英文', '中文', '标签', '添加时间', '学习时间', '复习次数', '稳定性', '难度', '间隔'],
      ...data.sentences.map(s => [
        s.id,
        s.english || '',
        s.chinese || '',
        (s.tags || []).join(', '),
        s.addedAt ? formatDate(s.addedAt) : '',
        s.learnedAt ? formatDate(s.learnedAt) : '',
        s.reps || 0,
        s.stability || 0,
        s.difficulty || 0,
        s.intervalIndex || 0,
      ]),
    ],
  });
  
  sheets.push({
    name: '时间统计',
    rows: [
      ['维度', '新增句子', '复习次数', '默写次数', '获得积分', '记忆保持', '学习天数', '完成率'],
      ...(['weekly', 'monthly', 'yearly', 'allTime'] as const).map(key => {
        const stat = data.timeStats[key];
        const label = key === 'weekly' ? '本周' : key === 'monthly' ? '本月' : key === 'yearly' ? '本年' : '累计';
        return [label, stat.newSentences, stat.reviewsCompleted, stat.dictationsCompleted, stat.pointsEarned, `${stat.avgRetention}%`, stat.streakDays, `${stat.completionRate}%`];
      }),
    ],
  });
  
  sheets.push({
    name: '用户统计',
    rows: [
      ['指标', '值'],
      ['连续学习天数', data.stats.streak || 0],
      ['累计积分', data.stats.totalPoints || 0],
      ['默写次数', data.stats.dictationCount || 0],
      ['总学习天数', data.stats.totalDaysLearned || 0],
      ['最高连续天数', data.stats.maxStreak || 0],
    ],
  });
  
  sheets.push({
    name: '日程事件',
    rows: [
      ['ID', '标题', '描述', '开始时间', '结束时间', '颜色', '重复', '已完成'],
      ...data.events.map(e => [
        e.id,
        e.title || '',
        e.description || '',
        formatDateTime(e.start),
        formatDateTime(e.end),
        e.color,
        e.repeat?.type || 'none',
        e.completed ? '是' : '否',
      ]),
    ],
  });
  
  if (data.trends.length > 0) {
    const trendRows: (string | number)[][] = [];
    data.trends.forEach(trend => {
      trendRows.push([`=== ${trend.label} ===`]);
      trendRows.push(['日期', '值']);
      trend.data.forEach(d => {
        trendRows.push([d.date, d.value]);
      });
      trendRows.push([]);
    });
    
    sheets.push({
      name: '趋势数据',
      rows: trendRows,
    });
  }
  
  const excelContent = generateExcelXML(sheets);
  const blob = new Blob([excelContent], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  downloadBlob(blob, `${filename}.xls`);
};

const generateExcelXML = (sheets: { name: string; rows: (string | number)[][] }[]): string => {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<?mso-application progid="Excel.Sheet"?>\n';
  xml += '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n';
  
  sheets.forEach(sheet => {
    xml += `<Worksheet ss:Name="${sheet.name}">\n`;
    xml += '<Table>\n';
    
    sheet.rows.forEach(row => {
      xml += '<Row>\n';
      row.forEach(cell => {
        const value = String(cell).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        xml += `<Cell><Data ss:Type="${typeof cell === 'number' ? 'Number' : 'String'}">${value}</Data></Cell>\n`;
      });
      xml += '</Row>\n';
    });
    
    xml += '</Table>\n';
    xml += '</Worksheet>\n';
  });
  
  xml += '</Workbook>';
  return xml;
};

const downloadBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

export const exportToJson = (data: ExportData, filename: string = 'export'): void => {
  const jsonContent = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8;' });
  downloadBlob(blob, `${filename}.json`);
};

export const prepareExportData = (
  sentences: Sentence[],
  stats: UserStats,
  timeStats: ExportData['timeStats'],
  events: ScheduleEvent[],
  trends: TrendData[] = [],
): ExportData => {
  return {
    sentences,
    stats,
    timeStats,
    events,
    trends,
  };
};
