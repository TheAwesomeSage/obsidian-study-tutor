/** Curated approved IDs only. The build embeds selected files; lessons never supply URLs. */
export interface VisualAsset { id: string; tags: string[]; path: string; width: number; height: number; source: string; license: string; licenseUrl: string; packVersion: string }
const license = "CC0-1.0", licenseUrl = "https://creativecommons.org/publicdomain/zero/1.0/";
export const ASSETS: VisualAsset[] = [
  {id:"kenney.physics.flag-blue",tags:["target","flag"],path:"assets/visuals/flag-blue.png",width:70,height:70,source:"https://kenney.nl/assets/physics-assets",license,licenseUrl,packVersion:"1.0"},
  {id:"kenney.physics.star-gold",tags:["decoration","star"],path:"assets/visuals/star-gold.png",width:70,height:70,source:"https://kenney.nl/assets/physics-assets",license,licenseUrl,packVersion:"1.0"},
  {id:"kenney.ui.checkmark-blue",tags:["badge","check"],path:"assets/visuals/checkmark-blue.png",width:20,height:18,source:"https://kenney.nl/assets/ui-pack",license,licenseUrl,packVersion:"2.0"},
];
