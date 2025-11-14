"use strict";
/*
 import { observe } from "redux-observers";
import {
  admiralIdObserver,
  listenToNicknameId,
  initDataWithAdmiralId,
} from "./views/redux";
import { store } from "views/create-store";
*/

let unsubscribeFunc;

export const windowMode = true;

const { i18n } = window;

export { reducer, reactClass } from "./views";

export function pluginDidLoad() {
  console.log("poi-plugin-sim loaded");
  console.log(`i18n instance:`, i18n);
}

export function pluginWillUnload() {
  if (unsubscribeFunc) {
    unsubscribeFunc();
  }
}
