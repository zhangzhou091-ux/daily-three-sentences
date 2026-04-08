import React, { useRef, useCallback } from 'react';
import { Achievement, TIER_CONFIG, ACHIEVEMENT_CATEGORIES } from '../../core/analytics/achievements';
import { LevelInfo } from '../../core/analytics/level';

interface AchievementShareCardProps {
  achievement: Achievement;
  level: LevelInfo;
  streak: number;
  onClose: () => void;
}

export const AchievementShareCard: React.FC<AchievementShareCardProps> = ({
  achievement,
  level,
  streak,
  onClose,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);

  const handleShare = useCallback(async () => {
    const shareData = {
      title: `我解锁了「${achievement.title}」成就！`,
      text: `${achievement.desc}\n\n连续学习 ${streak} 天 | 等级 ${level.level}\n\n来自 Daily Three Sentences`,
      url: window.location.origin,
    };

    if (navigator.share) {
      try {
        await navigator.share(shareData);
      } catch (err) {
        console.log('Share cancelled');
      }
    } else {
      const text = `${shareData.title}\n\n${shareData.text}`;
      await navigator.clipboard.writeText(text);
      alert('已复制到剪贴板！');
    }
  }, [achievement, level, streak]);

  const handleDownload = useCallback(() => {
    if (!cardRef.current) return;

    const canvas = document.createElement('canvas');
    const scale = 2;
    canvas.width = 400 * scale;
    canvas.height = 500 * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(scale, scale);

    const gradient = ctx.createLinearGradient(0, 0, 400, 500);
    gradient.addColorStop(0, '#667EEA');
    gradient.addColorStop(1, '#764BA2');
    ctx.fillStyle = gradient;
    ctx.roundRect(0, 0, 400, 500, 32);
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.beginPath();
    ctx.arc(350, 100, 150, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(50, 400, 100, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.font = 'bold 14px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('🎉 成就解锁', 200, 50);

    ctx.font = 'bold 48px system-ui';
    ctx.fillText(achievement.icon, 200, 150);

    ctx.fillStyle = 'white';
    ctx.font = 'bold 28px system-ui';
    ctx.fillText(achievement.title, 200, 220);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.font = '16px system-ui';
    ctx.fillText(achievement.desc, 200, 260);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.fillRect(50, 290, 300, 1);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.font = '14px system-ui';
    ctx.fillText(`等级 ${level.level} | 连续 ${streak} 天`, 200, 330);

    const tierConfig = TIER_CONFIG[achievement.tier];
    ctx.fillStyle = tierConfig.color === 'amber' ? '#FCD34D' : 
                    tierConfig.color === 'purple' ? '#C4B5FD' :
                    tierConfig.color === 'blue' ? '#93C5FD' : '#D1D5DB';
    ctx.font = 'bold 12px system-ui';
    ctx.fillText(`【${tierConfig.title}】`, 200, 360);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.font = '12px system-ui';
    ctx.fillText('Daily Three Sentences', 200, 470);

    const link = document.createElement('a');
    link.download = `achievement-${achievement.id}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }, [achievement, level, streak]);

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-[28px] p-6 max-w-sm mx-4 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-black text-gray-900">分享成就</h3>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-600 hover:bg-gray-200"
          >
            ✕
          </button>
        </div>

        <div
          ref={cardRef}
          className="bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl p-6 text-white text-center mb-4"
        >
          <div className="text-xs font-bold opacity-80 uppercase tracking-widest mb-2">
            🎉 成就解锁
          </div>
          <div className="text-5xl mb-3">{achievement.icon}</div>
          <div className="text-xl font-black mb-1">{achievement.title}</div>
          <div className="text-sm opacity-80 mb-4">{achievement.desc}</div>
          <div className="h-px bg-white/20 mb-4" />
          <div className="flex justify-center gap-4 text-sm">
            <span>等级 {level.level}</span>
            <span>•</span>
            <span>连续 {streak} 天</span>
          </div>
          <div className="mt-2 text-xs opacity-60">
            【{TIER_CONFIG[achievement.tier].title}】
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleShare}
            className="flex-1 py-3 bg-blue-500 text-white font-bold rounded-xl hover:bg-blue-600 transition-colors flex items-center justify-center gap-2"
          >
            <span>📤</span>
            <span>分享</span>
          </button>
          <button
            onClick={handleDownload}
            className="flex-1 py-3 bg-gray-100 text-gray-700 font-bold rounded-xl hover:bg-gray-200 transition-colors flex items-center justify-center gap-2"
          >
            <span>📥</span>
            <span>保存图片</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default AchievementShareCard;