import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { join } from './classNames.js';

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'default' | 'primary' | 'quiet';
  }
>(function Button({ variant = 'default', className, type = 'button', ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={join(`nv-button nv-button--${variant}`, className)}
      {...props}
    />
  );
});
