import { connect } from "react-redux";
import { createSelector } from "reselect";

const mapStateToProps = createSelector(
  (state: any) => state,
  (state) => ({ state })
);

export const connectComponent = (Component: any) => {
  return connect(mapStateToProps)(Component);
};
