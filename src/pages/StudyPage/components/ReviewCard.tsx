import React from 'react';
import { Sentence, DictationRecord, ReviewRating } from '../../../types';

interface ReviewCardProps {
  sentence: Sentence;
  onFlip: () => void;
  isFlipped: boolean;
  onReview: (id: string, rating: ReviewRating) => void;
}

export const ReviewCard: React.FC<ReviewCardProps> = ({ sentence, onFlip, isFlipped, onReview }) => {
  return (
    <div className="w-full max-w-2xl mx-auto perspective-1000">
      <div
        className={`relative w-full aspect-[4/3] transition-transform duration-700 transform-style-3d cursor-pointer ${
          isFlipped ? 'rotate-y-180' : ''
        }`}
        onClick={onFlip}
      >
        <div className="absolute w-full h-full backface-hidden">
          <div className="apple-card p-8 h-full flex flex-col justify-between bg-gradient-to-br from-white to-gray-50">
            <div className="flex justify-between items-start">
              <span className="text-xs font-bold text-blue-600 bg-blue-100 px-3 py-1 rounded-full">
                复习
              </span>
              <span className="text-xs text-gray-400">{sentence.id.slice(-8)}</span>
            </div>

            <div className="flex-1 flex items-center justify-center">
              <p className="text-2xl md:text-3xl font-bold text-gray-800 text-center leading-relaxed">
                {sentence.english}
              </p>
            </div>

            <div className="text-center">
              <p className="text-sm text-gray-500">点击翻转查看中文</p>
            </div>
          </div>
        </div>

        <div className="absolute w-full h-full backface-hidden rotate-y-180">
          <div className="apple-card p-8 h-full flex flex-col justify-between bg-gradient-to-br from-blue-50 to-white">
            <div className="flex justify-between items-start">
              <span className="text-xs font-bold text-blue-600 bg-blue-100 px-3 py-1 rounded-full">
                中文
              </span>
              <span className="text-xs text-gray-400">{sentence.id.slice(-8)}</span>
            </div>

            <div className="flex-1 flex items-center justify-center">
              <p className="text-xl md:text-2xl text-gray-800 text-center leading-relaxed">
                {sentence.chinese}
              </p>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-4 gap-2">
                {[1, 2, 3, 4].map((rating) => (
                  <button
                    key={rating}
                    onClick={(e) => {
                      e.stopPropagation();
                      onReview(sentence.id, rating as ReviewRating);
                    }}
                    className={`py-2 rounded-xl font-bold transition-colors ${
                      rating === 1
                        ? 'bg-red-100 text-red-600 hover:bg-red-200'
                        : rating === 2
                        ? 'bg-orange-100 text-orange-600 hover:bg-orange-200'
                        : rating === 3
                        ? 'bg-yellow-100 text-yellow-600 hover:bg-yellow-200'
                        : 'bg-green-100 text-green-600 hover:bg-green-200'
                    }`}
                  >
                    {rating === 1 ? '忘' : rating === 2 ? '难' : rating === 3 ? '会' : '熟'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
