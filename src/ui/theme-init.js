// Loaded as a blocking classic script in <head> of every page (see build.js: IIFE bundle), so the
// correct theme class is on <html> before anything paints.
import { applyTheme } from "./theme.js";

applyTheme();
