
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
    <nav className="glass rounded-[2rem] p-1.5 flex justify-around items-center w-full shadow-2xl shadow-black/10 border border-white/60 md:bg-transparent md:backdrop-blur-none md:border-none md:shadow-none md:w-auto md:gap-4">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => setView(tab.id as ViewType)}
          className={`relative flex-1 md:flex-none flex flex-col items-center py-2.5 md:py-2 md:px-6 rounded-[1.5rem] transition-all duration-300 ease-out group ${
            currentView === tab.id 
              ? 'bg-white shadow-sm text-blue-600 md:bg-black/5 md:text-black md:shadow-none' 
              : 'text-gray-600 hover:text-gray-800 hover:bg-black/5 active:scale-95'
          }`}
        >
          <span className={`text-xl mb-0.5 transition-transform duration-300 ${currentView === tab.id ? 'scale-110' : 'group-hover:scale-110'}`}>
            {tab.icon}
          </span>
          <span className="text-[10px] font-bold tracking-wider uppercase">{tab.label}</span>
          {currentView === tab.id && (
            <div className="absolute -bottom-1 md:bottom-0 w-1 h-1 bg-blue-600 md:bg-black rounded-full md:hidden" />
          )}
        </button>
      ))}
    </nav>
  );
};

export default Navbar;
