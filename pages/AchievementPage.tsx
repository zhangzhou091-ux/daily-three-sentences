
import React, { useMemo } from 'react';
import { Sentence } from '../types';
import { storageService } from '../services/storageService';

interface AchievementPageProps {
  sentences: Sentence[];
}

const AchievementPage: React.FC<AchievementPageProps> = ({ sentences }) => {
  const stats = storageService.getStats();
  
  // Fix: Calculate mastered sentences from the provided prop instead of calling an async service in render
  const mastered = sentences.filter(s => s.intervalIndex >= 7).length;

  const levelData = useMemo(() => {
    const points = stats.totalPoints;
    if (points < 200) return { lv: 1, title: '初级探索者', next: 200, color: 'from-blue-500 to-indigo-400' };
    if (points < 600) return { lv: 2, title: '新晋学者', next: 600, color: 'from-indigo-500 to-purple-400' };
    if (points < 1200) return { lv: 3, title: '勤奋达人', next: 1200, color: 'from-purple-500 to-pink-400' };
    if (points < 2500) return { lv: 4, title: '语境专家', next: 2500, color: 'from-pink-500 to-rose-400' };
    return { lv: 5, title: '英语大师', next: Math.max(points, 5000), color: 'from-rose-500 to-orange-400' };
  }, [stats.totalPoints]);

  const progressXP = (stats.totalPoints / levelData.next) * 100;

  const heatmap = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (6 - i));
      const dateStr = d.toISOString().split('T')[0];
      const dailyData = localStorage.getItem(`d3s_dictations_${dateStr}`);
      const hasActivity = dailyData && JSON.parse(dailyData).length > 0;
      return { 
        day: d.toLocaleDateString('zh-CN', { weekday: 'short' }),
        active: !!hasActivity 
      };
    });
  }, []);

  const milestones = [
    { title: '滴水穿石', icon: '🔥', target: 7, current: stats.streak, desc: '连续 7 天不间断学习' },
    // Fix: access length from prop sentences
    { title: '厚积薄发', icon: '🎓', target: 100, current: sentences.length, desc: '词库句子总数达到 100' },
    { title: '完全掌握', icon: '🏆', target: 50, current: mastered, desc: '彻底攻克 50 个复杂句子' },
    { title: '积分巨贾', icon: '💎', target: 2000, current: stats.totalPoints, desc: '累计获得超过 2000 积分' },
  ];

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-700">
      
      {/* Dynamic Profile Header Card */}
      <div className={`apple-card bg-gradient-to-br ${levelData.color} p-10 text-white relative overflow-hidden shadow-2xl shadow-blue-200/50`}>
        <div className="absolute -right-12 -top-12 w-48 h-48 bg-white/10 rounded-full blur-3xl" />
        <div className="absolute -left-12 -bottom-12 w-48 h-48 bg-black/10 rounded-full blur-3xl" />
        
        <div className="relative z-10 flex items-center gap-8 mb-10">
          <div className="w-24 h-24 bg-white/20 rounded-full flex items-center justify-center backdrop-blur-2xl border border-white/40 shadow-inner group transition-transform duration-500 hover:scale-105">
            <span className="text-5xl group-hover:rotate-12 transition-transform">🦁</span>
          </div>
          <div className="space-y-1">
            <h2 className="text-3xl font-black tracking-tighter uppercase">English Master</h2>
            <div className="flex items-center gap-2">
              <span className="bg-white/20 px-3 py-1 rounded-full text-[11px] font-black uppercase tracking-widest backdrop-blur-md">Level {levelData.lv}</span>
              <span className="text-white/80 text-xs font-bold">{levelData.title}</span>
            </div>
          </div>
        </div>

        <div className="relative z-10 space-y-3">
          <div className="flex justify-between items-end text-[10px] font-black uppercase tracking-[0.2em] opacity-80">
            <span>Progress to Next Level</span>
            <span>{stats.totalPoints} / {levelData.next} XP</span>
          </div>
          <div className="w-full bg-black/20 h-4 rounded-full overflow-hidden border border-white/20 backdrop-blur-lg p-0.5">
            <div 
              className="h-full bg-white rounded-full transition-all duration-1000 shadow-[0_0_20px_rgba(255,255,255,0.8)]"
              style={{ width: `${Math.min(100, progressXP)}%` }}
            />
          </div>
        </div>
      </div>

      {/* Main Stats Summary */}
      <div className="grid grid-cols-2 gap-4">
        <div className="apple-card p-8 flex flex-col items-center justify-center text-center space-y-3 group hover:-translate-y-1">
          <div className="w-14 h-14 bg-orange-50 rounded-[1.5rem] flex items-center justify-center text-2xl group-hover:scale-110 transition-transform">🔥</div>
          <div>
            <h4 className="text-2xl font-black text-gray-900 tracking-tight">{stats.streak}</h4>
            <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">天连续学习</p>
          </div>
        </div>
        <div className="apple-card p-8 flex flex-col items-center justify-center text-center space-y-3 group hover:-translate-y-1">
          <div className="w-14 h-14 bg-blue-50 rounded-[1.5rem] flex items-center justify-center text-2xl group-hover:scale-110 transition-transform">📚</div>
          <div>
            {/* Fix: access length from prop sentences */}
            <h4 className="text-2xl font-black text-gray-900 tracking-tight">{sentences.length}</h4>
            <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">个句子收藏</p>
          </div>
        </div>
      </div>

      {/* Learning Consistency Heatmap */}
      <div className="apple-card p-8 space-y-8">
        <div className="flex justify-between items-center">
          <h3 className="text-sm font-black text-gray-900 tracking-tight flex items-center gap-2">
            <span>📅</span> 学习热力图
          </h3>
          <span className="text-[9px] font-black text-blue-500 bg-blue-50 px-3 py-1 rounded-full uppercase tracking-widest">最近 7 天活跃</span>
        </div>
        <div className="flex justify-between items-end px-4">
          {heatmap.map((day, idx) => (
            <div key={idx} className="flex flex-col items-center gap-3">
              <div 
                className={`w-12 h-12 rounded-2xl transition-all duration-700 shadow-sm flex items-center justify-center ${
                  day.active 
                    ? 'bg-blue-600 shadow-blue-200 text-white scale-110' 
                    : 'bg-gray-100 text-gray-300'
                }`}
              >
                {day.active ? '✨' : ''}
              </div>
              <span className={`text-[10px] font-black uppercase tracking-widest ${day.active ? 'text-blue-600' : 'text-gray-300'}`}>
                {day.day}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Growth Milestones */}
      <div className="space-y-6">
        <h3 className="text-[11px] font-black text-gray-400 uppercase tracking-[0.3em] ml-6">荣誉勋章墙</h3>
        <div className="grid grid-cols-1 gap-4">
          {milestones.map((m, i) => {
            const progress = Math.min(100, (m.current / m.target) * 100);
            const isUnlocked = progress >= 100;
            return (
              <div key={i} className={`apple-card p-6 transition-all duration-500 border-2 ${isUnlocked ? 'border-blue-100 bg-white' : 'border-transparent bg-white/40'}`}>
                <div className="flex items-center gap-6">
                  <div className={`text-2xl w-16 h-16 flex items-center justify-center rounded-[1.5rem] shadow-sm ${isUnlocked ? 'bg-blue-600 text-white rotate-0' : 'bg-gray-100 text-gray-300 -rotate-12'}`}>
                    {m.icon}
                  </div>
                  <div className="flex-1">
                    <div className="flex justify-between items-end mb-2.5">
                      <div>
                        <h4 className={`font-black tracking-tight text-sm ${isUnlocked ? 'text-gray-900' : 'text-gray-400'}`}>{m.title}</h4>
                        <p className="text-[10px] text-gray-400 font-medium leading-tight max-w-[200px]">{m.desc}</p>
                      </div>
                      <span className={`text-[11px] font-black ${isUnlocked ? 'text-blue-600' : 'text-gray-300'}`}>{m.current} / {m.target}</span>
                    </div>
                    <div className="w-full bg-gray-100 h-1.5 rounded-full overflow-hidden p-0.5">
                      <div 
                        className={`h-full transition-all duration-1000 rounded-full ${isUnlocked ? 'bg-blue-600' : 'bg-blue-300/30'}`} 
                        style={{ width: `${progress}%` }} 
                      />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="text-center pb-8">
        <p className="text-[10px] font-black text-gray-300 uppercase tracking-[0.3em]">End of growth records</p>
      </div>
    </div>
  );
};

export default AchievementPage;
