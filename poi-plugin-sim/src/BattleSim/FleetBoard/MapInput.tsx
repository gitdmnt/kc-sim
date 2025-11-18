import React from "react";
import { useEffect, useState } from "react";
import { getArea, getMapsInArea } from "@utils/poiAPIWrapper";
import { fetchEnemyFromKCNav, fetchMapFromKCNav } from "@utils/KCNavAPIWrapper";
/* @ts-ignore */
import { wiki } from "@kancolle/data";
import { completeEnemyStatusFromKanColleData } from "@utils/KancolleDataWrapper";

import { Button } from "@/components/Button";

export const MapInput = ({
  setEnemyFleets,
  state,
}: {
  setEnemyFleets: React.Dispatch<
    React.SetStateAction<EnemyFleet[] | undefined>
  >;
  state: any;
}) => {
  const [area, setArea] = useState<number | undefined>(undefined);
  const [map, setMap] = useState<number | undefined>(undefined);
  const [node, setNode] = useState<string | undefined>(undefined);

  const areas = getArea(state);
  const maps = getMapsInArea(state, area!);
  const [nodes, setNodes] = useState<[string, string][]>([]);

  const [mapTrigger, setMapTrigger] = useState<boolean>(false);
  const [enemyTrigger, setEnemyTrigger] = useState<boolean>(false);

  // キャッシュ
  useEffect(() => {
    const savedData = localStorage.getItem("sim-map");
    console.log("Loaded map data:", savedData);
    if (savedData) {
      const data = JSON.parse(savedData);
      setArea(data.area);
      setMap(data.map);
      setNode(data.node);
      setNodes(data.nodes);
    }
  }, []);

  useEffect(() => {
    if (
      area === undefined ||
      map === undefined ||
      node === undefined ||
      nodes.length === 0
    ) {
      return;
    }
    const data = {
      area: area,
      map: map,
      node: node,
      nodes: nodes,
    };
    localStorage.setItem("sim-map", JSON.stringify(data));
    console.log("Saved map data:", { area, map, node, nodes });
  }, [area, map, node, nodes, mapTrigger, enemyTrigger]);

  // APIを叩く
  useEffect(() => {
    const fetchData = async () => {
      if (area === undefined || map === undefined) {
        return;
      }
      const fetchedNodes = await fetchMapFromKCNav(area!, map!);
      setNodes(fetchedNodes);
    };
    fetchData();
  }, [mapTrigger]);

  useEffect(() => {
    const fetchData = async () => {
      if (area === undefined || map === undefined || node === undefined) {
        return;
      }
      const enemyFleets = await fetchEnemyFromKCNav(area!, map!, node!);
      enemyFleets.map((fleet) => {
        fleet.ships = fleet.ships.map((ship) =>
          completeEnemyStatusFromKanColleData(ship, state)
        );
      });
      setEnemyFleets(enemyFleets);
    };
    fetchData();
  }, [enemyTrigger]);

  return (
    <div className="flex flex-col gap-8 bg-white text-gray-600 px-6 pt-10 pb-6 rounded shadow-inner shadow-gray-300 text-lg">
      <div className="flex flex-row gap-4 items-center flex-wrap">
        <select
          value={area}
          onChange={(e) => setArea(parseInt(e.target.value, 10))}
          className="w-full"
        >
          {areas.map((areaObj) => (
            <option key={areaObj.id} value={areaObj.id}>
              {areaObj.name} ({areaObj.id})
            </option>
          ))}
        </select>
        <select
          value={map}
          onChange={(e) => setMap(parseInt(e.target.value, 10))}
        >
          {maps.map((mapObj) => (
            <option key={mapObj.id} value={mapObj.id}>
              {mapObj.name} ({mapObj.id})
            </option>
          ))}
        </select>
        <select value={node} onChange={(e) => setNode(e.target.value)}>
          {nodes.map(([nodeStr, nodeType]) => (
            <option key={nodeStr} value={nodeStr}>
              {nodeStr} ({nodeType})
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-row flex-wrap gap-2 place-content-evenly">
        <Button onClick={() => setMapTrigger(!mapTrigger)}>Load Map</Button>
        <Button onClick={() => setEnemyTrigger(!enemyTrigger)}>
          Load Enemies
        </Button>
      </div>
    </div>
  );
};
