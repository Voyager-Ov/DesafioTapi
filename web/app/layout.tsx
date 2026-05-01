import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Tapi Flow Lab',
  description: 'Mini front para ejecutar la validación local del flujo y revisar logs por paso.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}