import React from "react";

import { connect } from "react-redux";
import { createSelector } from "reselect";
import { getFleets } from "poi-plugin-sim/src/hooks/getFleets";
// import "../assets/styles.css";

// mapStateToPropsでstoreのstateをcomponentのpropsに渡す
const mapStateToProps = createSelector(
  (state: any) => state,
  (state) => ({ state })
);

const App = ({ state }: { state: any }) => {
  console.log("Sim props:");
  console.log(JSON.stringify(state.info));
  const fleets = getFleets(state);
  console.log("fleets: ", fleets);

  return (
    <div>
      <h1>Sim!</h1>
      <div>
        {fleets.map((fleet: any, index: number) => (
          <div key={index}>
            <h2>Fleet {index + 1}</h2>
            <ul>
              {fleet.ships.map((ship: any, shipIndex: number) => (
                <li key={shipIndex}>
                  <div>{state.const.$ships[ship.eugenId].api_name}</div>
                  <div>HP: {ship.status.hp}</div>
                  <div>Firepower: {ship.status.firepower}</div>
                  <div>Equips:</div>
                  <ul>
                    {ship.equips.map((equip: any, equipIndex: number) => (
                      <li key={equipIndex}>
                        <div>
                          {state.const.$equips[equip.eugenId].api_name} -
                          Firepower: {equip.status.firepower}
                        </div>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
};

const ConnectedApp = connect(mapStateToProps)(App);

// poi will render this component in the plugin panel
export class reactClass extends React.Component {
  render() {
    return <ConnectedApp />;
  }
}
