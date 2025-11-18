import React from "react";

interface ButtonProps {
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}

export const Button = ({ onClick, children, className }: ButtonProps) => {
  return (
    <button className={`sim_button ${className}`} onClick={onClick}>
      <div className="text-white">{children}</div>
    </button>
  );
};
