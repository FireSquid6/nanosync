import type { ReactNode, RefObject } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  theme: 'dark' | 'light';
  triggerRef?: RefObject<HTMLElement | null>;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  theme,
  triggerRef,
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <div data-nv-theme={theme} className="nv-root nv-dialog-portal">
          <RadixDialog.Overlay className="nv-dialog-overlay" />
          <RadixDialog.Content
            className="nv-dialog-content"
            onCloseAutoFocus={event => {
              if (triggerRef?.current) {
                event.preventDefault();
                triggerRef.current.focus();
              }
            }}
          >
            <RadixDialog.Title>{title}</RadixDialog.Title>
            <RadixDialog.Description>{description}</RadixDialog.Description>
            {children}
          </RadixDialog.Content>
        </div>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
