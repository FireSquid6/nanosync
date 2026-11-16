import { forwardRef, type InputHTMLAttributes } from 'react';
import { join } from './classNames.js';

export const TextField = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }
>(function TextField({ label, hint, className, id, ...props }, ref) {
  return (
    <label className={join('nv-field', className)}>
      <span>{label}</span>
      <input id={id} ref={ref} {...props} />
      {hint && <small>{hint}</small>}
    </label>
  );
});
