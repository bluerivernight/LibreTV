// Libre — artwork with graceful states.
// Always renders the monogram tile; the remote image fades in on top when it
// loads. Missing/broken sources (including R2-relative keys that are not
// HTTP) simply leave the monogram — never a dark hole.

import { useState } from "react";

interface ArtworkProps {
  title: string;
  src: string | null;
  hue: number;
  className?: string;
  imgClassName?: string;
}

export function Artwork({ title, src, hue, className, imgClassName }: ArtworkProps) {
  const [loaded, setLoaded] = useState(false);
  const initial = title.charAt(0).toUpperCase() || "?";
  const remote = !!src && /^https?:\/\//.test(src);
  return (
    <span
      className={className ? `${className} artwork-live` : "artwork-live"}
      style={{ "--tile-hue": hue } as React.CSSProperties}
      aria-hidden="true"
    >
      {initial}
      {remote && (
        <img
          src={src}
          alt=""
          aria-hidden="true"
          loading="lazy"
          className={`${imgClassName ?? ""} ${loaded ? "is-loaded" : ""}`.trim()}
          onLoad={() => setLoaded(true)}
        />
      )}
    </span>
  );
}
