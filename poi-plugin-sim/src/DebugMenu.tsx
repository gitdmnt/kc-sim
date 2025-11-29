/* @ts-ignore */
import React from "react";
import { useEffect, useState } from "react";

import { Button } from "@/components/Button";

export const DebugMenu = () => {
  const [useMockApi, setUseMockApi] = useState(
    localStorage.getItem("debug-useMockApi") === "true"
  );

  useEffect(() => {
    if (useMockApi) {
      localStorage.setItem("debug-useMockApi", "true");
    } else {
      localStorage.setItem("debug-useMockApi", "false");
    }
  }, [useMockApi]);

  return (
    <div className="bg-white p-8 border border-gray-300 rounded">
      <div className="text-4xl font-bold mb-2">Debug Menu</div>
      <div className="flex flex-col gap-2 text-2xl text-gray-600">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="use-mock-api"
            checked={useMockApi}
            onChange={(e) => setUseMockApi(e.currentTarget.checked)}
          />
          <label htmlFor="use-mock-api">Use Mock API Data</label>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={clearCache}>Clear KCNav Cache</Button>
        </div>
      </div>
    </div>
  );
};

const clearCache = () => {
  if (window.confirm("Warning: This will clear all cached data. Proceed?")) {
    // Clear all localStorage entries with the "kcnav-" prefix
    Object.keys(localStorage).forEach((key) => {
      if (key.startsWith("kcnav-")) {
        localStorage.removeItem(key);
      }
    });
    console.log("Cache cleared");
  }
};
