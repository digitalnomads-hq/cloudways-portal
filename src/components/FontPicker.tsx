'use client';

import { useState, useRef, useEffect, KeyboardEvent } from 'react';

interface Props {
  name: string;
  value: string;
  onChange: (font: string) => void;
  fonts: string[];
  disabled?: boolean;
  placeholder?: string;
}

export default function FontPicker({ name, value, onChange, fonts, disabled, placeholder = 'Search fonts…' }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = query.trim()
    ? fonts.filter((f) => f.toLowerCase().includes(query.toLowerCase()))
    : fonts;

  // Close on outside click
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  // Scroll highlighted item into view
  useEffect(() => {
    const item = listRef.current?.children[highlighted] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  function select(font: string) {
    onChange(font);
    setQuery('');
    setOpen(false);
    setHighlighted(0);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[highlighted]) select(filtered[highlighted]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  function handleInputChange(val: string) {
    setQuery(val);
    setHighlighted(0);
    setOpen(true);
  }

  const displayValue = open ? query : value;

  return (
    <div ref={containerRef} className="relative">
      {/* Hidden input carries the selected value for form submission */}
      <input type="hidden" name={name} value={value} />

      <div
        className={`flex items-center gap-2 rounded-lg border px-3 py-2 bg-white transition ${open ? 'border-blue-500 ring-2 ring-blue-500' : 'border-gray-200'} ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
      >
        <input
          ref={inputRef}
          type="text"
          value={displayValue}
          placeholder={value || placeholder}
          onChange={(e) => handleInputChange(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          className="flex-1 text-sm text-gray-700 focus:outline-none bg-transparent min-w-0"
          autoComplete="off"
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => { setOpen((o) => !o); inputRef.current?.focus(); }}
          className="text-gray-400 hover:text-gray-600 flex-shrink-0"
          aria-label="Toggle font list"
        >
          <svg className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {open && filtered.length > 0 && (
        <ul
          ref={listRef}
          className="absolute z-50 mt-1 w-full max-h-56 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg text-sm"
          role="listbox"
        >
          {filtered.map((font, i) => (
            <li
              key={font}
              role="option"
              aria-selected={font === value}
              onMouseDown={() => select(font)}
              onMouseEnter={() => setHighlighted(i)}
              className={`px-3 py-2 cursor-pointer select-none ${i === highlighted ? 'bg-blue-50 text-blue-700' : font === value ? 'bg-gray-50 text-gray-900 font-medium' : 'text-gray-700 hover:bg-gray-50'}`}
            >
              {font}
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-3 py-2 text-gray-400">No fonts match &quot;{query}&quot;</li>
          )}
        </ul>
      )}

      {open && filtered.length === 0 && query && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg text-sm px-3 py-2 text-gray-400">
          No fonts match &quot;{query}&quot;
        </div>
      )}
    </div>
  );
}
