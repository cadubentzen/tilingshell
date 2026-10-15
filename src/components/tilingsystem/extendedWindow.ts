import Tile from '../../components/layout/Tile';
import { Mtk, Meta } from '../../gi/ext';

interface ExtendedWindow extends Meta.Window {
    originalSize: Mtk.Rectangle | undefined;
    assignedTile: Tile | undefined;
    inFocusMode: boolean | undefined;
}

export default ExtendedWindow;
