import React, { useMemo } from 'react';
import { DataPoint, TrendData } from '../../core/analytics/dataStats';

interface ChartProps {
  data: TrendData;
  height?: number;
  showGrid?: boolean;
  showLabels?: boolean;
  type?: 'line' | 'bar' | 'area';
}

export const SimpleChart: React.FC<ChartProps> = ({
  data,
  height = 200,
  showGrid = true,
  showLabels = true,
  type = 'line',
}) => {
  const chartData = useMemo(() => {
    if (data.data.length === 0) return null;
    
    const values = data.data.map(d => d.value);
    const maxVal = Math.max(...values, 1);
    const minVal = Math.min(...values, 0);
    const range = maxVal - minVal || 1;
    
    return {
      points: data.data.map((d, i) => ({
        x: (i / (data.data.length - 1 || 1)) * 100,
        y: 100 - ((d.value - minVal) / range) * 80 - 10,
        value: d.value,
        label: d.label,
        date: d.date,
      })),
      maxVal,
      minVal,
    };
  }, [data]);

  if (!chartData || data.data.length === 0) {
    return (
      <div 
        className="flex items-center justify-center bg-gray-50 rounded-xl"
        style={{ height }}
      >
        <span className="text-gray-600 text-sm">暂无数据</span>
      </div>
    );
  }

  const pathD = chartData.points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`)
    .join(' ');

  const areaD = `${pathD} L 100 100 L 0 100 Z`;

  return (
    <div className="relative" style={{ height }}>
      <svg 
        viewBox="0 0 100 100" 
        preserveAspectRatio="none"
        className="w-full h-full"
      >
        {showGrid && (
          <>
            {[0, 25, 50, 75, 100].map(y => (
              <line
                key={y}
                x1="0"
                y1={y}
                x2="100"
                y2={y}
                stroke="#E5E7EB"
                strokeWidth="0.5"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </>
        )}
        
        {type === 'area' && (
          <path
            d={areaD}
            fill={`url(#gradient-${data.label})`}
            opacity="0.3"
          />
        )}
        
        {type === 'bar' && chartData.points.map((p, i) => (
          <rect
            key={i}
            x={(i / chartData.points.length) * 100 + 1}
            y={p.y}
            width={100 / chartData.points.length - 2}
            height={100 - p.y}
            fill="#3B82F6"
            rx="1"
          />
        ))}
        
        {(type === 'line' || type === 'area') && (
          <>
            <defs>
              <linearGradient id={`gradient-${data.label}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3B82F6" />
                <stop offset="100%" stopColor="#3B82F6" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path
              d={pathD}
              fill="none"
              stroke="#3B82F6"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {chartData.points.map((p, i) => (
              <circle
                key={i}
                cx={p.x}
                cy={p.y}
                r="3"
                fill="white"
                stroke="#3B82F6"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
                className="hover:r-4 transition-all cursor-pointer"
              />
            ))}
          </>
        )}
      </svg>
      
      {showLabels && (
        <div className="absolute bottom-0 left-0 right-0 flex justify-between px-1 text-[9px] text-gray-600">
          {chartData.points.filter((_, i) => i % Math.ceil(chartData.points.length / 7) === 0).map((p, i) => (
            <span key={i}>{p.label}</span>
          ))}
        </div>
      )}
    </div>
  );
};

interface PieChartProps {
  data: { label: string; value: number; color: string }[];
  size?: number;
}

export const PieChart: React.FC<PieChartProps> = ({ data, size = 120 }) => {
  const total = useMemo(() => data.reduce((sum, d) => sum + d.value, 0), [data]);
  
  const segments = useMemo(() => {
    if (total === 0) return [];
    
    let currentAngle = -90;
    return data.map(d => {
      const angle = (d.value / total) * 360;
      const startAngle = currentAngle;
      currentAngle += angle;
      
      const startRad = (startAngle * Math.PI) / 180;
      const endRad = (currentAngle * Math.PI) / 180;
      
      const x1 = 50 + 40 * Math.cos(startRad);
      const y1 = 50 + 40 * Math.sin(startRad);
      const x2 = 50 + 40 * Math.cos(endRad);
      const y2 = 50 + 40 * Math.sin(endRad);
      
      const largeArc = angle > 180 ? 1 : 0;
      
      return {
        path: `M 50 50 L ${x1} ${y1} A 40 40 0 ${largeArc} 1 ${x2} ${y2} Z`,
        color: d.color,
        label: d.label,
        value: d.value,
        percent: Math.round((d.value / total) * 100),
      };
    });
  }, [data, total]);

  if (total === 0) {
    return (
      <div 
        className="flex items-center justify-center bg-gray-50 rounded-full"
        style={{ width: size, height: size }}
      >
        <span className="text-gray-600 text-xs">暂无数据</span>
      </div>
    );
  }

  return (
    <svg viewBox="0 0 100 100" style={{ width: size, height: size }}>
      {segments.map((seg, i) => (
        <path
          key={i}
          d={seg.path}
          fill={seg.color}
          stroke="white"
          strokeWidth="1"
        />
      ))}
    </svg>
  );
};

interface StatCardProps {
  title: string;
  value: number | string;
  unit?: string;
  icon: string;
  trend?: 'up' | 'down' | 'stable';
  changePercent?: number;
  color?: string;
}

export const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  unit,
  icon,
  trend,
  changePercent,
  color = '#3B82F6',
}) => {
  return (
    <div className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <span className="text-2xl">{icon}</span>
        {trend && changePercent !== undefined && (
          <span className={`text-xs font-bold flex items-center gap-0.5 ${
            trend === 'up' ? 'text-green-500' : trend === 'down' ? 'text-red-500' : 'text-gray-600'
          }`}>
            {trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→'}
            {Math.abs(changePercent)}%
          </span>
        )}
      </div>
      <div className="text-2xl font-black text-gray-900">
        {value}
        {unit && <span className="text-sm font-normal text-gray-600 ml-1">{unit}</span>}
      </div>
      <div className="text-xs text-gray-600 mt-1">{title}</div>
    </div>
  );
};

interface ComparisonCardProps {
  title: string;
  current: number;
  previous: number;
  mom: number;
  yoy: number;
  unit?: string;
}

export const ComparisonCard: React.FC<ComparisonCardProps> = ({
  title,
  current,
  previous,
  mom,
  yoy,
  unit = '',
}) => {
  return (
    <div className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm">
      <div className="text-xs font-bold text-gray-600 mb-3">{title}</div>
      <div className="text-3xl font-black text-gray-900 mb-3">
        {current}{unit}
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="bg-gray-50 rounded-lg p-2">
          <div className="text-gray-600">环比</div>
          <div className={`font-bold ${mom >= 0 ? 'text-green-500' : 'text-red-500'}`}>
            {mom >= 0 ? '+' : ''}{mom}%
          </div>
        </div>
        <div className="bg-gray-50 rounded-lg p-2">
          <div className="text-gray-600">同比</div>
          <div className={`font-bold ${yoy >= 0 ? 'text-green-500' : 'text-red-500'}`}>
            {yoy >= 0 ? '+' : ''}{yoy}%
          </div>
        </div>
      </div>
    </div>
  );
};
