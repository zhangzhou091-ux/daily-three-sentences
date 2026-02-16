
import React from 'react';
import { ViewType } from '../types';

interface NavbarProps {
  currentView: ViewType;
  setView: (view: ViewType) => void;
}

const Navbar: React.FC<NavbarProps> = ({ currentView, setView }) => {
  const tabs = [
    { id: 'study', label: '学习', icon: '📖' },
    { id: 'manage', label: '仓库', icon: '📦' },
    { id: 'achievements', label: '成长', icon: '✨' },
    { id: 'settings', label: '设置', icon: '⚙️' }
  ];

  return (
    <nav className="glass rounded-[2.5rem] p-1.5 flex justify-around items-center w-full shadow-2xl shadow-black/10 border border-white/60 sm:bg-transparent sm:backdrop-blur-none sm:border-none sm:shadow-none sm:w-auto sm:gap-2">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => setView(tab.id as ViewType)}
          className={`relative flex-1 sm:flex-none flex flex-col items-center py-3 sm:px-5 rounded-[2rem] transition-all duration-400 ease-out group ${
            currentView === tab.id 
              ? 'bg-white shadow-[0_8px_20px_rgba(0,0,0,0.06)] text-blue-600 sm:bg-black sm:text-white sm:shadow-none' 
              : 'text-gray-400 hover:text-gray-600 hover:bg-black/5 active:scale-95'
          }`}
        >
          <span className={`text-xl mb-0.5 transition-transform duration-300 ${currentView === tab.id ? 'scale-110' : 'group-hover:scale-110'}`}>
            {tab.icon}
          </span>
          <span className="text-[10px] font-bold tracking-wider uppercase">{tab.label}</span>
          {currentView === tab.id && (
            <div className="absolute -bottom-1 sm:bottom-1 w-1 h-1 bg-blue-600 sm:bg-white rounded-full sm:hidden" />
          )}
        </button>
      ))}
    </nav>
  );
};

export default Navbar;
