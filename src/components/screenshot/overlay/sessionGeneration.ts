import { createContext, useContext } from "react";

/** Native session owner; browser/dev direct overlays keep their legacy path. */
export const ScreenshotSessionGeneration = createContext<number | undefined>(undefined);
export const useScreenshotSessionGeneration = () => useContext(ScreenshotSessionGeneration);
