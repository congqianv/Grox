/* Fullscreen image preview for session thumbnails and tool outputs. */

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../fx/Icon";
import { useI18n } from "../../lib/i18n";

export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt?: string;
  onClose(): void;
}) {
  const { language } = useI18n();

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={language === "zh-CN" ? "图片预览" : "Image preview"}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/72 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
        title={language === "zh-CN" ? "关闭" : "Close"}
      >
        <Icon name="x" size={16} />
      </button>
      <img
        src={src}
        alt={alt ?? ""}
        className="max-h-[min(92vh,1200px)] max-w-[min(96vw,1400px)] rounded-lg object-contain shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      />
      {alt ? (
        <p className="pointer-events-none absolute bottom-5 left-1/2 max-w-[80vw] -translate-x-1/2 truncate rounded-full bg-black/50 px-3 py-1 text-[12px] text-white/90">
          {alt}
        </p>
      ) : null}
    </div>,
    document.body,
  );
}
