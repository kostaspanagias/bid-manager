import type { SVGProps } from 'react';

/** The few inline icons the app needs (16px grid, stroke = currentColor). Add paths here, not icon packages. */
const PATHS = {
  menu: 'M2.5 4.5h11M2.5 8h11M2.5 11.5h11',
  close: 'M4 4l8 8M12 4l-8 8',
  check: 'M3.5 8.5l3 3 6-7',
  chevronDown: 'M4 6l4 4 4-4',
  chevronLeft: 'M10 4L6 8l4 4',
  chevronRight: 'M6 4l4 4-4 4',
  plus: 'M8 3v10M3 8h10',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  search: 'M7 12A5 5 0 107 2a5 5 0 000 10zM11 11l3 3',
  alert: 'M8 2.2l6.3 11H1.7L8 2.2zM8 6.5v3.2M8 11.6h.01',
  info: 'M8 14A6 6 0 108 2a6 6 0 000 12zM8 7.2v3.6M8 5.2h.01',
  checkCircle: 'M8 14A6 6 0 108 2a6 6 0 000 12zM5.5 8.2l1.8 1.8 3.4-3.8',
  block: 'M8 14A6 6 0 108 2a6 6 0 000 12zM3.8 3.8l8.4 8.4',
  upload: 'M8 10.5V2.5M5 5.2l3-3 3 3M2.5 10.5v2a1 1 0 001 1h9a1 1 0 001-1v-2',
  download: 'M8 2.5v8M5 7.8l3 3 3-3M2.5 10.5v2a1 1 0 001 1h9a1 1 0 001-1v-2',
  copy: 'M5.5 5.5v-2a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1h-2M3.5 5.5h6a1 1 0 011 1v6a1 1 0 01-1 1h-6a1 1 0 01-1-1v-6a1 1 0 011-1z',
  edit: 'M2.5 13.5l.6-2.9 7.6-7.6a1.3 1.3 0 011.8 0l.5.5a1.3 1.3 0 010 1.8l-7.6 7.6-2.9.6zM9.6 4.1l2.3 2.3',
  trash: 'M2.5 4.5h11M6 4.5v-2h4v2M4 4.5l.6 8a1 1 0 001 1h4.8a1 1 0 001-1l.6-8M6.6 7v4M9.4 7v4',
  logout: 'M6 2.5H3.5a1 1 0 00-1 1v9a1 1 0 001 1H6M10.5 5l3 3-3 3M13.5 8H6',
  user: 'M8 8a2.8 2.8 0 100-5.6A2.8 2.8 0 008 8zM2.8 13.6c.5-2.3 2.6-3.6 5.2-3.6s4.700 1.300 5.2 3.6',
  calendar: 'M2.5 4a1 1 0 011-1h9a1 1 0 011 1v8.500a1 1 0 01-1 1h-9a1 1 0 01-1-1V4zM2.5 6.500h11M5.500 1.800V4M10.500 1.800V4',
  file: 'M4 1.800h5l3.500 3.500v8a1 1 0 01-1 1H4a1 1 0 01-1-1v-10.500a1 1 0 011-1zM9 1.800v3.500h3.500',
  external: 'M9 2.500h4.500V7M13.500 2.500L7.500 8.500M11.500 9.500v3a1 1 0 01-1 1h-7a1 1 0 01-1-1v-7a1 1 0 011-1h3',
  lock: 'M4 7.200h8a1 1 0 011 1v4.300a1 1 0 01-1 1H4a1 1 0 01-1-1V8.200a1 1 0 011-1zM5.300 7.200V5a2.700 2.700 0 015.400 0v2.200',
  filter: 'M2 3.500h12l-4.600 5.300v4l-2.800-1.400V8.800L2 3.500z',
  dashboard: 'M2.500 2.500h4.500v6H2.500zM9 2.500h4.500v3.500H9zM9 8h4.500v5.500H9zM2.500 10.500h4.500v3H2.500z',
  folder: 'M1.800 4a1 1 0 011-1h3.300l1.500 1.700h5.600a1 1 0 011 1V12a1 1 0 01-1 1H2.800a1 1 0 01-1-1V4z',
  inbox: 'M2 9l2-6h8l2 6v3.500a1 1 0 01-1 1H3a1 1 0 01-1-1V9zM2 9h3.500l.800 1.600h3.400L10.500 9H14',
  shield: 'M8 1.800l5 1.800v4c0 3-2.100 5.300-5 6.400-2.900-1.100-5-3.400-5-6.400v-4l5-1.800z',
  users: 'M6 7.500A2.400 2.400 0 106 2.700a2.400 2.400 0 000 4.800zM1.500 13c.4-2 2.200-3.200 4.500-3.200s4.100 1.200 4.500 3.200M10.800 7.400a2.200 2.200 0 000-4.400M12.300 9.900c1.200.400 2 1.400 2.300 2.800',
  layers: 'M8 2l6 3-6 3-6-3 6-3zM2 8l6 3 6-3M2 11l6 3 6-3',
  history: 'M2.500 8a5.500 5.500 0 101.700-4M2.500 2.500V5H5M8 5v3.200l2 1.300',
} as const;

export type IconName = keyof typeof PATHS;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  /** px, default 16 */
  size?: number;
  /** Accessible name; omit for decorative icons (aria-hidden). */
  title?: string;
}

export function Icon({ name, size = 16, title, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      style={{ flex: 'none' }}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
