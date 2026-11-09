import React from 'react';

export const MonitoringIcon: React.FC<React.HTMLAttributes<HTMLSpanElement>> = ({
  className = '',
  style,
  ...props
}) => (
  <span
    aria-hidden="true"
    {...props}
    className={`inline-block shrink-0 bg-current ${className}`}
    style={{
      maskImage: "url('/monitoring-24-7.png')",
      maskSize: 'contain',
      maskRepeat: 'no-repeat',
      maskPosition: 'center',
      WebkitMaskImage: "url('/monitoring-24-7.png')",
      WebkitMaskSize: 'contain',
      WebkitMaskRepeat: 'no-repeat',
      WebkitMaskPosition: 'center',
      ...style,
    }}
  />
);

type MonitoringMenuIconProps = React.SVGProps<SVGSVGElement> & {
  active?: boolean;
};

export const MonitoringMenuIcon: React.FC<MonitoringMenuIconProps> = ({ active = false, ...props }) => {
  const gradientId = React.useId();

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke={`url(#${gradientId})`}
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <defs>
        <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="24" y2="24">
          <stop stopColor={active ? '#f2b8ce' : '#d77b9f'} />
          <stop offset="50%" stopColor={active ? '#c2bcf0' : '#a385d5'} />
          <stop offset="100%" stopColor={active ? '#bdd5ff' : '#85aceb'} />
        </linearGradient>
      </defs>
      <path d="M12 8H3a1 1 0 0 0-1 1v10h17v-6" />
      <path d="M1.5 19h19v1.5A1.5 1.5 0 0 1 19 22H3a1.5 1.5 0 0 1-1.5-1.5Z" />
      <path d="m5 14 2-3 2.5 5 2-3H15" />
      <circle cx="18" cy="6" r="4.5" />
      <path d="M18 3.5V6l2 1" />
    </svg>
  );
};
