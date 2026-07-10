// Polyfills must load before the SDK: Hermes lacks these globals.
import "react-native-get-random-values";
import "web-streams-polyfill/polyfill";

import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(App);
