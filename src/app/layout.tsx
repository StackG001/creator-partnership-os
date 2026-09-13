import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Creator Partnership OS',
  description: 'Find, audit, equip and launch micro-creators.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          background: '#0d0d0f',
          color: '#f5f5f4',
        }}
      >
        {children}
      </body>
    </html>
  );
}
