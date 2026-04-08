import React, { useState, useEffect, useCallback } from 'react';
import { Achievement } from '../../core/analytics/achievements';

interface AchievementNotificationProps {
  achievement: Achievement;
  onClose: () => void;
}

export const AchievementNotification: React.FC<AchievementNotificationProps> = ({ achievement, onClose }) => {
  const [isVisible, setIsVisible] = useState(false);
  const [showConfetti, setShowConfetti] = useState(true);

  useEffect(() => {
    requestAnimationFrame(() => {
      setIsVisible(true);
    });

    const timer = setTimeout(() => {
      setShowConfetti(false);
    }, 3000);

    const closeTimer = setTimeout(() => {
      setIsVisible(false);
      setTimeout(onClose, 300);
    }, 5000);

    return () => {
      clearTimeout(timer);
      clearTimeout(closeTimer);
    };
  }, [onClose]);

  return (
    <div
      className={`fixed inset-0 z-[200] flex items-center justify-center transition-all duration-300 ${
        isVisible ? 'bg-black/50 backdrop-blur-sm' : 'bg-transparent pointer-events-none'
      }`}
      onClick={() => {
        setIsVisible(false);
        setTimeout(onClose, 300);
      }}
    >
      {showConfetti && <Confetti />}

      <div
        className={`relative bg-white rounded-[32px] p-8 shadow-2xl max-w-sm mx-4 transform transition-all duration-500 ${
          isVisible ? 'scale-100 opacity-100' : 'scale-75 opacity-0'
        }`}
        onClick={e => e.stopPropagation()}
      >
        <div className="absolute -top-6 left-1/2 -translate-x-1/2">
          <div className="w-16 h-16 bg-gradient-to-br from-amber-400 to-orange-500 rounded-full flex items-center justify-center text-3xl shadow-lg animate-bounce">
            {achievement.icon}
          </div>
        </div>

        <div className="text-center mt-6">
          <div className="text-xs font-black text-amber-500 uppercase tracking-widest mb-2">
            🎉 成就解锁
          </div>
          <h3 className="text-xl font-black text-gray-900 mb-2">{achievement.title}</h3>
          <p className="text-sm text-gray-600 mb-4">{achievement.desc}</p>

          {achievement.rewards.length > 0 && (
            <div className="bg-gray-50 rounded-xl p-3 mb-4">
              <div className="text-[10px] font-bold text-gray-600 uppercase tracking-wider mb-2">
                获得奖励
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {achievement.rewards.map((reward, i) => (
                  <span
                    key={i}
                    className={`text-xs font-bold px-3 py-1 rounded-full ${
                      reward.type === 'points'
                        ? 'bg-amber-100 text-amber-700'
                        : reward.type === 'badge'
                        ? 'bg-purple-100 text-purple-700'
                        : reward.type === 'title'
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-gray-100 text-gray-700'
                    }`}
                  >
                    {reward.type === 'points' && `+${reward.value} 积分`}
                    {reward.type === 'badge' && `🏅 ${reward.description}`}
                    {reward.type === 'title' && `👑 ${reward.value}`}
                    {reward.type === 'resource' && `📖 ${reward.description}`}
                  </span>
                ))}
              </div>
            </div>
          )}

          <button
            onClick={() => {
              setIsVisible(false);
              setTimeout(onClose, 300);
            }}
            className="w-full py-3 bg-gradient-to-r from-amber-500 to-orange-500 text-white font-bold rounded-xl hover:from-amber-600 hover:to-orange-600 transition-all"
          >
            太棒了！
          </button>
        </div>
      </div>
    </div>
  );
};

const Confetti: React.FC = () => {
  const colors = ['#FFD700', '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8'];

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {Array.from({ length: 50 }).map((_, i) => (
        <div
          key={i}
          className="absolute animate-confetti"
          style={{
            left: `${Math.random() * 100}%`,
            top: '-10px',
            width: `${Math.random() * 10 + 5}px`,
            height: `${Math.random() * 10 + 5}px`,
            backgroundColor: colors[Math.floor(Math.random() * colors.length)],
            borderRadius: Math.random() > 0.5 ? '50%' : '0',
            animationDelay: `${Math.random() * 2}s`,
            animationDuration: `${Math.random() * 2 + 2}s`,
          }}
        />
      ))}
    </div>
  );
};

interface AchievementNotificationManagerProps {
  notifications: Achievement[];
  onDismiss: (id: string) => void;
}

export const AchievementNotificationManager: React.FC<AchievementNotificationManagerProps> = ({
  notifications,
  onDismiss,
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);

  const currentNotification = notifications[currentIndex];

  const handleClose = useCallback(() => {
    if (currentNotification) {
      onDismiss(currentNotification.id);
      setCurrentIndex(prev => Math.min(prev + 1, notifications.length - 1));
    }
  }, [currentNotification, onDismiss, notifications.length]);

  useEffect(() => {
    setCurrentIndex(0);
  }, [notifications.length]);

  if (!currentNotification) return null;

  return <AchievementNotification achievement={currentNotification} onClose={handleClose} />;
};

export default AchievementNotification;