import React, { useMemo, useState, useEffect, memo } from 'react';
import { Sentence } from '../../types';
import { getSafeTags } from '../../utils/format';
import { 
  PieChart, Pie, Cell, Tooltip, 
  BarChart, Bar, XAxis, YAxis 
} from 'recharts';

interface StatisticsSectionProps {
  sentences: Sentence[];
  onImportClick: () => void;
  importStatus: 'idle' | 'validating' | 'importing' | 'done' | 'error';
}

const ChartLoadingFallback = () => (
  <div className="h-48 flex items-center justify-center">
    <div className="animate-pulse text-gray-300 text-xs">加载图表中...</div>
  </div>
);

const PieChartComponent = memo(({ data }: { data: { name: string; value: number; color: string }[] }) => (
  <PieChart width={200} height={200}>
    <Pie data={data} dataKey="value" innerRadius={50} outerRadius={70} paddingAngle={10} stroke="none">
      {data.map((entry, index) => (
        <Cell key={`cell-${index}`} fill={entry.color} />
      ))}
    </Pie>
    <Tooltip contentStyle={{ borderRadius: '1.2rem', border: 'none', boxShadow: '0 8px 24px rgba(0,0,0,0.05)' }} />
  </PieChart>
));

const BarChartComponent = memo(({ data }: { data: { name: string; value: number }[] }) => (
  <BarChart width={300} height={150} data={data} layout="vertical" margin={{ left: 0, right: 30 }}>
    <XAxis type="number" hide />
    <YAxis dataKey="name" type="category" axisLine={false} tickLine={false} tick={{ fontSize: 11, fontWeight: 700, fill: '#1f2937' }} width={60} />
    <Bar dataKey="value" fill="#3b82f6" radius={[0, 8, 8, 0]} barSize={12} />
  </BarChart>
));

export const StatisticsSection: React.FC<StatisticsSectionProps> = memo(({ sentences, onImportClick, importStatus }) => {
  const [chartsReady, setChartsReady] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setChartsReady(true);
    }, 300);
    return () => clearTimeout(timer);
  }, []);

  const stats = useMemo(() => {
    if (sentences.length === 0) {
      return {
        mastery: [{ name: '初识', value: 0, color: '#e5e7eb' }, { name: '复习中', value: 0, color: '#3b82f6' }, { name: '完全掌握', value: 0, color: '#10b981' }],
        tagData: []
      };
    }

    const mastery = [
      { name: '初识', value: sentences.filter(s => s.intervalIndex === 0).length, color: '#e5e7eb' },
      { name: '复习中', value: sentences.filter(s => s.intervalIndex > 0 && s.intervalIndex < 9).length, color: '#3b82f6' },
      { name: '完全掌握', value: sentences.filter(s => s.intervalIndex >= 9).length, color: '#10b981' }
    ];
    
    const tagMap: Record<string, number> = {};
    sentences.forEach(s => {
      const tags = getSafeTags(s.tags);
      tags.forEach(tag => {
        tagMap[tag] = (tagMap[tag] || 0) + 1;
      });
    });
    
    const tagData = Object.entries(tagMap)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
    
    return { mastery, tagData };
  }, [sentences]);

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-700">
      <div className="grid grid-cols-2 gap-4">
        <div className="apple-card p-8 flex flex-col justify-center items-center text-center">
          <p className="text-[10px] font-black text-gray-600 uppercase tracking-widest mb-2">DB 存储版本</p>
          <h4 className="text-3xl font-black text-blue-600">v1.1</h4>
        </div>
        <div className="apple-card p-8 flex flex-col justify-center items-center text-center">
          <p className="text-[10px] font-black text-gray-600 uppercase tracking-widest mb-2">数据库条目</p>
          <h4 className="text-3xl font-black text-gray-800">{sentences.length}</h4>
        </div>
      </div>

      <div className="apple-card p-10 space-y-10">
        <div className="flex justify-between items-center">
          <h2 className="text-xl font-black text-gray-900 tracking-tight">知识库全景分析</h2>
          <button 
            onClick={onImportClick}
            disabled={importStatus === 'importing' || importStatus === 'validating'}
            className="text-[10px] font-black text-green-600 bg-green-50 px-4 py-2 rounded-full uppercase tracking-widest hover:bg-green-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {importStatus === 'validating' ? '验证中...' : importStatus === 'importing' ? '导入中...' : '📥 导入 Excel'}
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
          <div className="space-y-6 text-center md:text-left min-w-0">
            <h3 className="text-[11px] font-black text-gray-600 uppercase tracking-widest">MASTERY DISTRIBUTION</h3>
            <div className="h-48 min-h-48 relative flex justify-center w-full min-w-0">
              {chartsReady ? (
                <PieChartComponent data={stats.mastery} />
              ) : (
                <ChartLoadingFallback />
              )}
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span className="text-2xl font-black text-gray-800">{sentences.length}</span>
                <span className="text-[8px] font-bold text-gray-600 uppercase tracking-widest">RECORDS</span>
              </div>
            </div>
          </div>
          <div className="space-y-6 min-w-0">
            <h3 className="text-[11px] font-black text-gray-600 uppercase tracking-widest">HOT KEYWORDS</h3>
            <div className="h-48 min-h-48 flex justify-center w-full min-w-0">
              {chartsReady && stats.tagData.length > 0 ? (
                <BarChartComponent data={stats.tagData} />
              ) : stats.tagData.length === 0 ? (
                <div className="h-full flex items-center justify-center text-gray-600 text-xs italic">库内暂无标签</div>
              ) : (
                <ChartLoadingFallback />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
