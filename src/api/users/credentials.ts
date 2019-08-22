import { Router } from "express";
import { getCompleteUserFromId } from "../../helpers";
import logger from "../../logger";
import AEError, { sendError } from "../../errors";

const route = Router();

route.get('/', (req, res) => {
    // Retourne des infos sur l'utilisateur connecté
    const user = getCompleteUserFromId(req.user!.user_id);

    user
        .then(u => {
            if (u) {
                res.json(u);
            }
            else {
                sendError(AEError.forbidden, res);
            }
        })
        .catch(e => {
            logger.error("Error while fetching user:", e);
            sendError(AEError.server_error, res);
        });
});

export default route;
