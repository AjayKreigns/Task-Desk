import React, { useEffect, useState } from 'react';
import { animate } from 'framer-motion';

export default function AnimatedCounter({ from = 0, to, duration = 1.2, format = Math.round }) {
  const [value, setValue] = useState(from);

  useEffect(() => {
    const controls = animate(from, to, {
      duration: duration,
      ease: "easeOut",
      onUpdate(val) {
        setValue(val);
      }
    });
    return () => controls.stop();
  }, [from, to, duration]);

  return <span>{format(value)}</span>;
}
