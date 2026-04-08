import React, { useMemo } from 'react';

interface HeatmapDay {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
}

interface ContributionHeatmapProps {
  data: HeatmapDay[];
  year: number;
}

const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const DAYS = ['一', '三', '五'];

const LEVEL_COLORS = [
  'bg-gray-100',
  'bg-emerald-200',
  'bg-emerald-300',
  'bg-emerald-400',
  'bg-emerald-500',
];

const getMonthLabel = (month: number, year: number): string => {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startWeek = firstDay.getDay() || 7;
  return MONTHS[month];
};

export const ContributionHeatmap: React.FC<ContributionHeatmapProps> = ({ data, year }) => {
  const heatmapData = useMemo(() => {
    const dataMap = new Map<string, HeatmapDay>();
    data.forEach(d => dataMap.set(d.date, d));

    const weeks: HeatmapDay[][] = [];
    const firstDay = new Date(year, 0, 1);
    const lastDay = new Date(year, 11, 31);

    let currentWeek: HeatmapDay[] = [];
    const startPadding = (firstDay.getDay() || 7) - 1;
    for (let i = 0; i < startPadding; i++) {
      currentWeek.push({ date: '', count: 0, level: 0 });
    }

    for (let d = new Date(firstDay); d <= lastDay; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      const existing = dataMap.get(dateStr);

      if (existing) {
        currentWeek.push(existing);
      } else {
        currentWeek.push({ date: dateStr, count: 0, level: 0 });
      }

      if (currentWeek.length === 7) {
        weeks.push(currentWeek);
        currentWeek = [];
      }
    }

    if (currentWeek.length > 0) {
      while (currentWeek.length < 7) {
        currentWeek.push({ date: '', count: 0, level: 0 });
      }
      weeks.push(currentWeek);
    }

    return weeks;
  }, [data, year]);

  const months = useMemo(() => {
    const result: { label: string; weekIndex: number }[] = [];
    let lastMonth = -1;

    heatmapData.forEach((week, weekIndex) => {
      const validDay = week.find(d => d.date);
      if (validDay) {
        const month = new Date(validDay.date).getMonth();
        if (month !== lastMonth) {
          result.push({ label: MONTHS[month], weekIndex });
          lastMonth = month;
        }
      }
    });

    return result;
  }, [heatmapData]);

  const totalContributions = useMemo(() => {
    return data.reduce((sum, d) => sum + d.count, 0);
  }, [data]);

  const maxCount = useMemo(() => {
    return Math.max(1, ...data.map(d => d.count));
  }, [data]);

  return (
    <div className="bg-white/60 backdrop-blur-xl rounded-[28px] p-6 border border-white/40">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-black text-gray-900 flex items-center gap-2">
          <span className="w-1.5 h-4 bg-emerald-500 rounded-full"></span>
          学习热力图
        </h3>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-gray-600">less</span>
            {LEVEL_COLORS.map((color, i) => (
              <div key={i} className={`w-3 h-3 rounded-sm ${color}`} />
            ))}
            <span className="text-[10px] text-gray-600">more</span>
          </div>
          <div className="text-xs font-bold text-gray-600">
            {totalContributions} 次学习
          </div>
        </div>
      </div>

      <div className="overflow-x-auto pb-2">
        <div className="inline-block min-w-max">
          <div className="flex text-[9px] text-gray-600 mb-1 ml-8">
            {months.map((m, i) => (
              <div
                key={i}
                className="text-center"
                style={{
                  marginLeft: i === 0 ? 0 : `${(m.weekIndex - months[i - 1].weekIndex - 1) * 14}px`,
                  minWidth: '14px'
                }}
              >
                {m.label}
              </div>
            ))}
          </div>

          <div className="flex gap-1">
            <div className="flex flex-col gap-[3px] text-[9px] text-gray-600 mr-1">
              {DAYS.map((day, i) => (
                <div key={i} className="h-3 flex items-center" style={{ visibility: i % 2 === 0 ? 'visible' : 'hidden' }}>
                  {day}
                </div>
              ))}
            </div>

            {heatmapData.map((week, weekIndex) => (
              <div key={weekIndex} className="flex flex-col gap-[3px]">
                {week.map((day, dayIndex) => (
                  <div
                    key={dayIndex}
                    className={`w-3 h-3 rounded-sm ${day.date ? LEVEL_COLORS[day.level] : 'bg-transparent'}`}
                    title={day.date ? `${day.date}: ${day.count} 次` : ''}
                  />
                ))}
              </div>
            ))}
          </div>

          <div className="flex items-center justify-end gap-4 mt-4">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-600">最大: {maxCount} 次</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export const generateHeatmapData = (
  sentences: { addedAt?: number | null; lastReviewedAt?: number | null }[],
  year: number
): HeatmapDay[] => {
  const dataMap = new Map<string, number>();

  sentences.forEach(s => {
    if (s.lastReviewedAt != null) {
      const date = new Date(s.lastReviewedAt);
      if (date.getFullYear() === year) {
        const dateStr = date.toISOString().split('T')[0];
        dataMap.set(dateStr, (dataMap.get(dateStr) || 0) + 1);
      }
    } else if (s.addedAt != null) {
      const date = new Date(s.addedAt);
      if (date.getFullYear() === year) {
        const dateStr = date.toISOString().split('T')[0];
        dataMap.set(dateStr, (dataMap.get(dateStr) || 0) + 1);
      }
    }
  });

  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31);

  for (let d = new Date(yearStart); d <= yearEnd; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    if (!dataMap.has(dateStr)) {
      dataMap.set(dateStr, 0);
    }
  }

  const maxCount = Math.max(1, ...Array.from(dataMap.values()));

  return Array.from(dataMap.entries())
    .map(([date, count]) => ({
      date,
      count,
      level: (count === 0 ? 0 : count <= maxCount * 0.25 ? 1 : count <= maxCount * 0.5 ? 2 : count <= maxCount * 0.75 ? 3 : 4) as 0 | 1 | 2 | 3 | 4,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
};