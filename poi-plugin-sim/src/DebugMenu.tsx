import { ToggleButton } from "react-bootstrap";
import { useEffect, useState } from "react";

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
    <div className="bg-white p-2 border border-gray-300 rounded">
      <h2 className="text-lg font-bold mb-2">Debug Menu</h2>
      <div className="flex flex-col gap-2 text-sm text-gray-600">
        <div className="flex items-center gap-2">
          <ToggleButton
            id="use-mock-api"
            type="checkbox"
            variant="outline-secondary"
            size="sm"
            value={useMockApi ? "1" : "0"}
            checked={useMockApi}
            onChange={(e) => setUseMockApi(e.currentTarget.checked)}
          >
            Use Mock API
          </ToggleButton>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="bg-gray-500 text-white px-4 py-1 rounded-full hover:bg-gray-600"
            onClick={clearCache}
          >
            Clear KCNav Cache
          </button>
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
