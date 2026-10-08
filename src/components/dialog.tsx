"use client";

import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";

export default function Dialog({ title, onClose, children }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  return (
    <dialog ref={ref} className="app-dialog" aria-labelledby={titleId} onCancel={onClose} onClick={(event) => {
      if (event.target === event.currentTarget) {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }
    }}>
      <div className="dialog-header"><h2 id={titleId}>{title}</h2><button className="icon-button" type="button" onClick={onClose} aria-label="Stäng information"><X size={21} /></button></div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
