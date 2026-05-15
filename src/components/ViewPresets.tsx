'use client';

import { motion } from 'framer-motion';
import { Globe, MapPin } from 'lucide-react';

interface ViewPresetsProps {
  onNavigate: (lat: number, lng: number, zoom: number) => void;
}

const PRESETS = [
  { label: 'AFRICA',   lat:   5, lng:   20, zoom: 3.0 },
  { label: 'AMERICAS', lat:  20, lng:  -80, zoom: 2.3 },
  { label: 'ARCTIC',   lat:  75, lng:    0, zoom: 2.0 },
  { label: 'ASIA',     lat:  35, lng:  100, zoom: 3.0 },
  { label: 'EUROPE',   lat:  50, lng:   15, zoom: 4.0 },
  { label: 'OCEANIA',  lat:   0, lng:  135, zoom: 2.5 },
];

export default function ViewPresets({ onNavigate }: ViewPresetsProps) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.7, duration: 0.6 }}
      className="glass-panel p-2.5 pointer-events-auto"
    >
      <div className="flex items-center gap-2 mb-2">
        <Globe className="w-4 h-4 text-[var(--gold-primary)]" />
        <span className="hud-text text-[12px] text-[var(--text-primary)] tracking-widest">REGION PRESETS</span>
      </div>
      <div className="grid grid-cols-2 gap-1">
        {PRESETS.map(p => (
          <button
            key={p.label}
            onClick={() => onNavigate(p.lat, p.lng, p.zoom)}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded text-[10px] font-mono tracking-wider text-[var(--text-muted)] border border-transparent hover:border-[var(--border-primary)] hover:bg-[var(--hover-accent)] hover:text-[var(--gold-primary)] transition-all"
          >
            <MapPin className="w-3 h-3 flex-shrink-0" />
            <span>{p.label}</span>
          </button>
        ))}
      </div>
    </motion.div>
  );
}
