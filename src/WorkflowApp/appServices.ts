import * as readline from 'readline';
import { log } from '../test/helpers/BPMNTester';
import axios from 'axios';
import { group } from 'console';

const cl = readline.createInterface(process.stdin, process.stdout);
const question = function (q) {
    return new Promise((res, rej) => {
        cl.question(q, answer => {
            res(answer);
        })
    });
};
async function delay(time, result?) {
    console.log("delaying ... " + time)
    return new Promise(function (resolve) {
        setTimeout(function () {
            console.log("delayed is done.");
            resolve(result);
        }, time);
    });
}

class AppServices {
    appDelegate;
    server;
    constructor(delegate) {
        this.appDelegate = delegate;
        this.server = delegate.server;
    }

    async echo(input, context) {
        context.item.data['echo'] = input;
        console.log(context.item.data);
        return input;
    }

    async createTicket(input, context) {
        let item = context.item;

        const ticketContent = input.tickets;
        console.log("Début de la tâche de service");

        const initSessionUrl = process.env.ITSM_HOST + process.env.ITSM_URI + "/apirest.php/initSession";
        const ticketApiUrl = process.env.ITSM_HOST + process.env.ITSM_URI + "/apirest.php/Ticket/";
        const appToken = process.env.ITSM_APP_TOKEN;

        try {
            const sessionResponse = await axios.get(initSessionUrl, {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "user_token " + process.env.ITSM_USER_TOKEN,
                    "App-Token": appToken,
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache"
                },
            });

            if (sessionResponse.status === 200 && sessionResponse.data && sessionResponse.data.session_token) {
                const sessionToken = sessionResponse.data.session_token;

                const headers = {
                    "Content-Type": "application/json",
                    "Session-Token": sessionToken,
                    "App-Token": appToken,
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache"
                };

                // Changement vers profil superadmin
                const getActiveProfileUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/getActiveProfile/`;
                const profileResponse = await axios.get(getActiveProfileUrl, { headers });

                if (profileResponse.data.id !== 4) {
                    const changeProfileUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/changeActiveProfile/`;
                    await axios.post(changeProfileUrl, { profiles_id: 4 }, { headers });
                }

                // Traitement du placeholder ##fullform## si présent
                let processedDescription = ticketContent.description;
                const descriptionStr = String(ticketContent.description || '').toLowerCase();

                if (descriptionStr.includes('fullform') && ticketContent.formId) {
                    console.log(`Détection de ##fullform## avec formId=${ticketContent.formId}, génération du contenu formaté...`);
                    try {
                        const metadata = await AppServices.fetchFormCreatorMetadata(
                            ticketContent.formId,
                            sessionToken,
                            appToken
                        );
                        const formattedContent = await AppServices.generateFormattedHtmlContent(
                            context.item.data,
                            metadata,
                            sessionToken,
                            appToken
                        );
                        if (formattedContent) {
                            // Remplacer le placeholder (tolère 1 ou 2 # de chaque côté à cause du parsing XML)
                            processedDescription = ticketContent.description.replace(/#{1,2}fullform#{1,2}/gi, formattedContent);
                            console.log("Contenu du formulaire généré avec succès");
                        }
                    } catch (formError) {
                        console.error("Erreur lors de la génération du contenu formulaire:", formError.message);
                    }
                }

                // Création du payload pour le ticket
                const payload = {
                    input: {
                        name: ticketContent.title,
                        content: processedDescription,
                        users_id_assign: ticketContent.users_id_assign || null,
                        _users_id_assign: ticketContent.users_id_assign || null,
                        _groups_id_assign: ticketContent.groups_id_assign || null,
                        groups_id_assign: ticketContent.groups_id_assign || null,
                        _users_id_requester: ticketContent.users_id_requester || null,
                        users_id_requester: ticketContent.users_id_requester || null,
                        users_id_observer: ticketContent.users_id_observer || null,
                        _users_id_observer: ticketContent.users_id_observer || null,
                        status: 1,
                        entities_id: 0,
                        itilcategories_id: ticketContent.itilcategories_id || null,
                        type: ticketContent.type || null,
                        location_id: ticketContent.location_id || null,
                        urgency: ticketContent.urgency || null,
                        impact: ticketContent.impact || null,
                        priority: ticketContent.priority || null,
                    },
                };

                const ticketResponse = await axios.post(ticketApiUrl, payload, { headers });

                if (ticketResponse.status === 201) {
                    const createdTicketId = ticketResponse.data.id;
                    console.log("ID du ticket créé:", createdTicketId);

                    context.item.data.ticketId = createdTicketId;

                    // Supprimer l'utilisateur API des assignations si un groupe est assigné
                    if (ticketContent.groups_id_assign) {
                        try {
                            const ticketUsersUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket/${createdTicketId}/Ticket_User`;
                            const existingAssignments = await axios.get(ticketUsersUrl, { headers });

                            if (existingAssignments.data && Array.isArray(existingAssignments.data)) {
                                for (const assignment of existingAssignments.data) {
                                    // Supprimer les assignations de type 2 (assigné) sauf si explicitement demandé
                                    if (assignment.type === 2 && !ticketContent.users_id_assign) {
                                        const deleteUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket_User/`;
                                        await axios.delete(deleteUrl, {
                                            headers,
                                            data: { input: { id: assignment.id }, force_purge: true }
                                        });
                                        console.log(`Assignation utilisateur ${assignment.users_id} supprimée (groupe assigné)`);
                                    }
                                }
                            }
                        } catch (cleanupError) {
                            console.error("Erreur lors du nettoyage des assignations:", cleanupError.message);
                        }
                    }

                    // Gestion de l'assignation si nécessaire
                    if (ticketContent.users_id_assign && ticketResponse.data.users_id_assign != ticketContent.users_id_assign) {
                        const assignUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket/${createdTicketId}/Ticket_User`;
                        const assignPayload = {
                            input: {
                                tickets_id: createdTicketId,
                                users_id: ticketContent.users_id_assign,
                                type: 2
                            }
                        };

                        try {
                            await axios.post(assignUrl, assignPayload, { headers });
                        } catch (assignError) {
                            try {
                                const updateUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket/${createdTicketId}`;
                                const updatePayload = {
                                    input: {
                                        users_id_assign: ticketContent.users_id_assign
                                    }
                                };

                                await axios.put(updateUrl, updatePayload, { headers });
                            } catch (updateError) {
                                console.error("Erreur lors de la mise à jour de l'assignation");
                            }
                        }
                    }

                    // Ajout de la validation si nécessaire
                    if (context.item.data.ticketValidation) {
                        const validationUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/TicketValidation/`;
                        const validationInput = context.item.data.ticketValidation.input;

                        // Si un groupe est assigné au ticket, récupérer tous les membres et créer une validation pour chacun
                        if (ticketContent.groups_id_assign) {
                            console.log(`Groupe assigné: ${ticketContent.groups_id_assign}. Récupération des membres...`);

                            // Récupération des membres du groupe via l'API GLPI
                            let groupMembers = [];
                            try {
                                const groupUsersUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Group/${ticketContent.groups_id_assign}/Group_User/`;
                                const groupResponse = await axios.get(groupUsersUrl, { headers });

                                if (groupResponse.status === 200 && groupResponse.data) {
                                    groupMembers = groupResponse.data
                                        .filter(item => item.users_id)
                                        .map(item => item.users_id);
                                    console.log(`Membres du groupe ${ticketContent.groups_id_assign}:`, groupMembers);
                                }
                            } catch (groupError) {
                                console.error(`Erreur lors de la récupération des membres du groupe:`, groupError.message);
                            }

                            if (groupMembers.length > 0) {
                                console.log(`Création de ${groupMembers.length} demandes de validation pour les membres du groupe`);

                                // Créer une demande de validation pour chaque membre du groupe
                                for (const userId of groupMembers) {
                                    const validationPayload = {
                                        input: {
                                            tickets_id: createdTicketId,
                                            users_id_validate: userId,
                                            comment_submission: validationInput.comment_submission || "Validation requise par le groupe",
                                            validation_status: 2
                                        }
                                    };

                                    try {
                                        const validationResponse = await axios.post(validationUrl, validationPayload, { headers });
                                        console.log(`Validation créée pour l'utilisateur ${userId}, ID: ${validationResponse.data.id}`);
                                    } catch (validationError) {
                                        console.error(`Erreur lors de la création de la validation pour l'utilisateur ${userId}:`, validationError.message);
                                    }
                                }
                            } else {
                                console.log("Aucun membre trouvé dans le groupe, pas de validation créée");
                            }
                        } else {
                            // Comportement classique: validation par utilisateur ou groupe unique
                            const validationPayload = {
                                input: {
                                    tickets_id: createdTicketId,
                                    users_id_validate: validationInput.users_id_validate,
                                    groups_id_validate: validationInput.groups_id_validate,
                                    comment_submission: validationInput.comment_submission,
                                    validation_status: 2
                                }
                            };

                            try {
                                await axios.post(validationUrl, validationPayload, { headers });
                            } catch (validationError) {
                                try {
                                    const updateUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket/${createdTicketId}`;
                                    const updatePayload = {
                                        input: {
                                            global_validation: 2,
                                            users_id_validate: validationInput.users_id_validate
                                        }
                                    };

                                    await axios.put(updateUrl, updatePayload, { headers });
                                } catch (updateError) {
                                    console.error("Erreur lors de la mise à jour du ticket");
                                }
                            }
                        }
                    }

                    console.log("Tâche de service terminée avec succès");

                    return {
                        ticketId: createdTicketId
                    };
                } else {
                    return {
                        error: "Échec de création de ticket"
                    };
                }
            } else {
                return {
                    error: "Échec de récupération du token de session"
                };
            }
        } catch (error) {
            console.error("Erreur lors de la communication avec l'API:", error.message);
            return {
                error: "Erreur de communication avec l'API: " + error.message
            };
        } finally {
            console.log("Fin de la tâche de service");
        }
    }

    async pollTicketValidation(input, context) {
        const ticketId = context.item.data.ticketId;

        if (!ticketId) {
            context.item.data.ticketValidated = false;
            return { error: "ID de ticket manquant", validated: false };
        }

        const ticketApiUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket/${ticketId}?expand_dropdowns=true`;
        const ticketValidationsUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket/${ticketId}/TicketValidation`;
        const appToken = process.env.ITSM_APP_TOKEN;

        try {
            const sessionResponse = await axios.get(`${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/initSession`, {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "user_token " + process.env.ITSM_USER_TOKEN,
                    "App-Token": appToken,
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache"
                },
            });

            if (sessionResponse.status !== 200 || !sessionResponse.data.session_token) {
                context.item.data.ticketValidated = false;
                return { error: "Échec de récupération du token de session", validated: false };
            }

            const sessionToken = sessionResponse.data.session_token;
            const headers = {
                "Content-Type": "application/json",
                "Session-Token": sessionToken,
                "App-Token": appToken,
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Pragma": "no-cache"
            };

            try {
                const changeProfileUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/changeActiveProfile/`;
                await axios.post(changeProfileUrl, { profiles_id: 4 }, { headers });
            } catch (profileError) {
                console.error("Erreur lors du changement de profil");
            }

            let attempts = 0;
            const interval = 5000;
            const maxAttempts = 10000;

            // Suivre les validations déjà vues
            if (!context.item.data.seenValidations) {
                context.item.data.seenValidations = [];
            }

            while (attempts < maxAttempts) {
                try {
                    const ticketResponse = await axios.get(ticketApiUrl, { headers });
                    const validationsResponse = await axios.get(ticketValidationsUrl, { headers });

                    if (ticketResponse.status === 200 && ticketResponse.data) {
                        const ticket = ticketResponse.data;

                        if (ticket.id && ticket.id == ticketId) {
                            // Vérifier si le ticket est clos
                            if (ticket.status === 6) {
                                context.item.data.ticket_closed = true;
                                return { validated: true, ticket_closed: true };
                            }

                            const globalValidationStatus = ticket.global_validation;
                            console.log(`Ticket ${ticketId}, Validation globale = ${globalValidationStatus}`);

                            // Vérifier les validations individuelles refusées ou acceptées
                            let hasNewRejection = false;
                            let rejectionUserName = "";
                            let hasNewApproval = false;
                            let approvalUserId = null;

                            if (validationsResponse.status === 200 && Array.isArray(validationsResponse.data)) {
                                for (const validation of validationsResponse.data) {
                                    const alreadySeen = context.item.data.seenValidations.includes(validation.id);

                                    if (validation.status === 4 && !alreadySeen) { // 4 = Refusé
                                        hasNewRejection = true;
                                        rejectionUserName = validation.users_id_validate;
                                        context.item.data.seenValidations.push(validation.id);
                                        context.item.data.rejectedBy = validation.users_id_validate;
                                        break;
                                    } else if (validation.status === 3 && !alreadySeen) { // 3 = Accepté
                                        hasNewApproval = true;
                                        approvalUserId = validation.users_id_validate;
                                        context.item.data.seenValidations.push(validation.id);
                                        context.item.data.approvedBy = validation.users_id_validate;
                                        console.log(`Validation acceptée par l'utilisateur ${approvalUserId}`);
                                        break;
                                    }
                                }
                            }

                            if (hasNewRejection) {
                                context.item.data.ticketValidated = false;
                                context.item.data.ticket_closed = false;
                                return { validated: false, ticket_closed: false, rejectedBy: rejectionUserName };
                            } else if (hasNewApproval && approvalUserId) {
                                // Assigner automatiquement l'utilisateur qui a validé au ticket
                                console.log(`Assignation automatique du ticket à l'utilisateur ${approvalUserId} qui a validé`);

                                try {
                                    //  Récupérer les assignations existantes
                                    const ticketUsersUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket/${ticketId}/Ticket_User`;
                                    const existingAssignments = await axios.get(ticketUsersUrl, { headers });

                                    //  Supprimer toutes les assignations de type 2 (assigné) existantes et les mettre en observateurs
                                    if (existingAssignments.data && Array.isArray(existingAssignments.data)) {
                                        for (const assignment of existingAssignments.data) {
                                            if (assignment.type === 2 && assignment.users_id != approvalUserId) {
                                                // Supprimer l'ancienne assignation
                                                try {
                                                    const deleteUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket_User/`;
                                                    await axios.delete(deleteUrl, {
                                                        headers,
                                                        data: { input: { id: assignment.id }, force_purge: true }
                                                    });
                                                    console.log(`Ancienne assignation supprimée pour l'utilisateur ${assignment.users_id}`);

                                                    // Ajouter comme observateur
                                                    const observerPayload = {
                                                        input: {
                                                            tickets_id: ticketId,
                                                            users_id: assignment.users_id,
                                                            type: 3 // Observateur
                                                        }
                                                    };
                                                    await axios.post(`${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket_User/`, observerPayload, { headers });
                                                    console.log(`Utilisateur ${assignment.users_id} mis en observateur`);
                                                } catch (deleteError) {
                                                    console.error(`Erreur lors de la suppression de l'assignation:`, deleteError.message);
                                                }
                                            }
                                        }
                                    }

                                    // Supprimer toutes les assignations de groupe de type 2
                                    const ticketGroupsUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket/${ticketId}/Group_Ticket`;
                                    try {
                                        const existingGroupAssignments = await axios.get(ticketGroupsUrl, { headers });

                                        if (existingGroupAssignments.data && Array.isArray(existingGroupAssignments.data)) {
                                            for (const groupAssignment of existingGroupAssignments.data) {
                                                if (groupAssignment.type === 2) {
                                                    try {
                                                        const deleteGroupUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Group_Ticket/`;
                                                        await axios.delete(deleteGroupUrl, {
                                                            headers,
                                                            data: { input: { id: groupAssignment.id }, force_purge: true }
                                                        });
                                                        console.log(`Assignation de groupe ${groupAssignment.groups_id} supprimée`);
                                                    } catch (deleteGroupError) {
                                                        console.error(`Erreur lors de la suppression de l'assignation de groupe:`, deleteGroupError.message);
                                                    }
                                                }
                                            }
                                        }
                                    } catch (groupError) {
                                        console.error(`Erreur lors de la récupération des groupes assignés:`, groupError.message);
                                    }

                                    // Vérifier si l'utilisateur qui a validé est déjà assigné
                                    const isAlreadyAssigned = existingAssignments.data && Array.isArray(existingAssignments.data) ?
                                        existingAssignments.data.some(a => a.users_id == approvalUserId && a.type === 2) : false;

                                    if (!isAlreadyAssigned) {
                                        // Assigner l'utilisateur qui a validé
                                        const assignPayload = {
                                            input: {
                                                tickets_id: ticketId,
                                                users_id: approvalUserId,
                                                type: 2 // Assigné
                                            }
                                        };

                                        const assignUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket_User/`;
                                        await axios.post(assignUrl, assignPayload, { headers });
                                        console.log(`Utilisateur ${approvalUserId} assigné au ticket ${ticketId} avec succès`);

                                        //Mettre à jour le ticket lui-même pour s'assurer que users_id_assign est correct
                                        const updateTicketUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket/${ticketId}`;
                                        const updateTicketPayload = {
                                            input: {
                                                users_id_assign: approvalUserId
                                            }
                                        };
                                        await axios.put(updateTicketUrl, updateTicketPayload, { headers });
                                        console.log(`Champ users_id_assign du ticket mis à jour avec l'utilisateur ${approvalUserId}`);
                                    } else {
                                        console.log(`Utilisateur ${approvalUserId} déjà assigné au ticket`);
                                    }
                                } catch (assignError) {
                                    console.error(`Erreur lors de l'assignation de l'utilisateur ${approvalUserId}:`, assignError.message);
                                }

                                // Attendre que le global_validation devienne 3 pour confirmer
                                context.item.data.ticketValidated = true;
                                context.item.data.ticket_closed = false;
                                return { validated: true, ticket_closed: false, assignedTo: approvalUserId };
                            } else if (globalValidationStatus === 3) {
                                context.item.data.ticketValidated = true;
                                context.item.data.ticket_closed = false;
                                return { validated: true, ticket_closed: false };
                            } else if (globalValidationStatus === 4) {
                                context.item.data.ticketValidated = false;
                                context.item.data.ticket_closed = false;
                                return { validated: false, ticket_closed: false };
                            }
                        }
                    }
                } catch (responseError) {
                    console.error("Erreur lors de la requête");
                }

                attempts++;
                if (attempts < maxAttempts) await new Promise(resolve => setTimeout(resolve, interval));
            }

            context.item.data.ticketValidated = false;
            context.item.data.ticket_closed = false;
            return { validated: false, ticket_closed: false, timeout: true };
        } catch (error) {
            console.error("Erreur lors du polling");
            context.item.data.ticketValidated = false;
            context.item.data.ticket_closed = false;
            return { error: "Erreur lors du polling", validated: false, ticket_closed: false };
        }
    }

    async addTicketFollowup(input, context) {
        let item = context.item;
        const ticketId = context.item.data.ticketId;

        if (!ticketId) {
            return { error: "ID de ticket manquant" };
        }

        console.log("Début de la tâche d'ajout de suivi");

        const initSessionUrl = process.env.ITSM_HOST + process.env.ITSM_URI + "/apirest.php/initSession";
        const followupUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/ITILFollowup/`;
        const appToken = process.env.ITSM_APP_TOKEN;

        let followupContent = "Ticket clos, fin du processus";

        // Définir le contenu du followup
        if (input.followupData && input.followupData.content) {
            followupContent = input.followupData.content;
        } else if (context.item.data.followup && context.item.data.followup.content) {
            followupContent = context.item.data.followup.content;
        }

        try {
            const sessionResponse = await axios.get(initSessionUrl, {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "user_token " + process.env.ITSM_USER_TOKEN,
                    "App-Token": appToken,
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache"
                },
            });

            if (sessionResponse.status === 200 && sessionResponse.data && sessionResponse.data.session_token) {
                const sessionToken = sessionResponse.data.session_token;

                const headers = {
                    "Content-Type": "application/json",
                    "Session-Token": sessionToken,
                    "App-Token": appToken,
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache"
                };

                // Passer en profil superadmin
                const getActiveProfileUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/getActiveProfile/`;
                const profileResponse = await axios.get(getActiveProfileUrl, { headers });

                if (profileResponse.data.id !== 4) {
                    const changeProfileUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/changeActiveProfile/`;
                    await axios.post(changeProfileUrl, { profiles_id: 4 }, { headers });
                }

                // Création du followup
                const followupPayload = {
                    input: {
                        itemtype: "Ticket",
                        items_id: ticketId,
                        content: followupContent,
                        is_private: 0,
                        requesttypes_id: 1
                    }
                };

                const followupResponse = await axios.post(followupUrl, followupPayload, { headers });

                if (followupResponse.status === 201) {
                    console.log("Suivi ajouté avec succès, ID:", followupResponse.data.id);
                    return { success: true, followupId: followupResponse.data.id };
                } else {
                    return { error: "Échec d'ajout de suivi", details: followupResponse.data };
                }
            } else {
                return { error: "Échec de récupération du token de session" };
            }
        } catch (error) {
            console.error("Erreur lors de la communication avec l'API:", error.message);
            return { error: "Erreur de communication avec l'API: " + error.message };
        } finally {
            console.log("Fin de la tâche d'ajout de suivi");
        }
    }

    async addTask(input, context) {
        let item = context.item;
        const ticketId = context.item.data.ticketId;

        if (!ticketId) {
            return { error: "ID de ticket manquant" };
        }

        console.log("Début de la tâche d'ajout de tâche");

        const initSessionUrl = process.env.ITSM_HOST + process.env.ITSM_URI + "/apirest.php/initSession";
        const taskUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/TicketTask/`;
        const appToken = process.env.ITSM_APP_TOKEN;

        let taskContent = input.taskData && input.taskData.content ?
            input.taskData.content : "Tâche ajoutée automatiquement par le workflow";

        try {
            const sessionResponse = await axios.get(initSessionUrl, {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "user_token " + process.env.ITSM_USER_TOKEN,
                    "App-Token": appToken,
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache"
                },
            });

            if (sessionResponse.status === 200 && sessionResponse.data && sessionResponse.data.session_token) {
                const sessionToken = sessionResponse.data.session_token;

                const headers = {
                    "Content-Type": "application/json",
                    "Session-Token": sessionToken,
                    "App-Token": appToken,
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache"
                };

                // Passer en profil superadmin
                const getActiveProfileUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/getActiveProfile/`;
                const profileResponse = await axios.get(getActiveProfileUrl, { headers });

                if (profileResponse.data.id !== 4) {
                    const changeProfileUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/changeActiveProfile/`;
                    await axios.post(changeProfileUrl, { profiles_id: 4 }, { headers });
                }

                // Création de la tâche
                const taskPayload = {
                    input: {
                        tickets_id: ticketId,
                        content: taskContent,
                        is_private: input.taskData && input.taskData.is_private !== undefined ?
                            input.taskData.is_private ? 1 : 0 : 0,
                        users_id_tech: input.taskData && input.taskData.users_id_tech ?
                            input.taskData.users_id_tech : 0,
                        state: 1,
                        groups_id_tech: input.taskData && input.taskData.groups_id_tech ? input.taskData.groups_id_tech : null
                    }
                };

                const taskResponse = await axios.post(taskUrl, taskPayload, { headers });

                if (taskResponse.status === 201) {
                    console.log("Tâche ajoutée avec succès, ID:", taskResponse.data.id);
                    return { success: true, taskId: taskResponse.data.id };
                } else {
                    return { error: "Échec d'ajout de tâche", details: taskResponse.data };
                }
            } else {
                return { error: "Échec de récupération du token de session" };
            }
        } catch (error) {
            console.error("Erreur lors de la communication avec l'API:", error.message);
            return { error: "Erreur de communication avec l'API: " + error.message };
        } finally {
            console.log("Fin de la tâche d'ajout de tâche");
        }
    }

    async pollAssignment(input, context) {
        const ticketId = context.item.data.ticketId;

        if (!ticketId) {
            return { error: "ID de ticket manquant" };
        }

        const appToken = process.env.ITSM_APP_TOKEN;
        const ticketUsersUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket/${ticketId}/Ticket_User`;

        const maxAttempts = 10000;
        const interval = 5000;
        let attempts = 0;

        while (attempts < maxAttempts) {
            try {
                const sessionResponse = await axios.get(`${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/initSession`, {
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": "user_token " + process.env.ITSM_USER_TOKEN,
                        "App-Token": appToken,
                    }
                });

                if (sessionResponse.status === 200 && sessionResponse.data.session_token) {
                    const headers = {
                        "Content-Type": "application/json",
                        "Session-Token": sessionResponse.data.session_token,
                        "App-Token": appToken,
                    };

                    const usersResponse = await axios.get(ticketUsersUrl, { headers });

                    if (usersResponse.status === 200 && Array.isArray(usersResponse.data)) {
                        const assignedTech = usersResponse.data.find(a => a.type === 2);

                        if (assignedTech) {
                            console.log("Tech assigné trouvé:", assignedTech.users_id);
                            context.item.data.assignedTechId = assignedTech.users_id;
                            return { success: true, assignedTechId: assignedTech.users_id };
                        }
                    }
                }
            } catch (error) {
                console.error("Erreur pollAssignment:", error.message);
            }

            attempts++;
            console.log(`pollAssignment: tentative ${attempts}, pas encore assigné...`);
            await new Promise(resolve => setTimeout(resolve, interval));
        }

        return { error: "Timeout: aucun tech assigné", success: false };
    }

    async updateTicket(input, context) {
        try {
            const ticketId = input.ticketUpdate.id;
            const appToken = process.env.ITSM_APP_TOKEN;

            // Obtenir un jeton de session
            const sessionResponse = await axios.get(`${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/initSession`, {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "user_token " + process.env.ITSM_USER_TOKEN,
                    "App-Token": appToken,
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache"
                },
            });

            if (sessionResponse.status !== 200 || !sessionResponse.data.session_token) {
                return { error: "Échec de récupération du token de session" };
            }

            const sessionToken = sessionResponse.data.session_token;
            const headers = {
                "Content-Type": "application/json",
                "Session-Token": sessionToken,
                "App-Token": appToken,
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Pragma": "no-cache"
            };

            // Passer en profil superadmin
            try {
                const changeProfileUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/changeActiveProfile/`;
                await axios.post(changeProfileUrl, { profiles_id: 4 }, { headers });
            } catch (profileError) {
                console.error("Erreur lors du changement de profil");
            }

            // Récupérer les assignations existantes
            const ticketUsersUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket/${ticketId}/Ticket_User`;
            const existingAssignments = await axios.get(ticketUsersUrl, { headers });

            // Récupérer les assignations de groupes existantes
            const ticketGroupsUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket/${ticketId}/Group_Ticket`;
            const existingGroupAssignments = await axios.get(ticketGroupsUrl, { headers });

            // Stocker l'ID de l'utilisateur ou groupe actuel
            const currentUserId = input.ticketUpdate.users_id_assign;
            const currentGroupId = input.ticketUpdate.groups_id_assign;

            // Traiter les assignations utilisateur existantes
            if (existingAssignments.data && Array.isArray(existingAssignments.data)) {
                const assignmentsToRemove = existingAssignments.data.filter(assignment =>
                    assignment.type === 2 && assignment.users_id != currentUserId
                );

                for (const assignment of assignmentsToRemove) {
                    // Supprimer l'assignation
                    try {
                        const deleteUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket_User/`;
                        const deletePayload = {
                            input: { id: assignment.id },
                            force_purge: true
                        };

                        await axios.delete(deleteUrl, { headers, data: deletePayload });
                    } catch (deleteError) {
                        console.error("Erreur lors de la suppression d'assignation");
                    }

                    // Ajouter comme observateur
                    try {
                        const observerPayload = {
                            input: {
                                tickets_id: ticketId,
                                users_id: assignment.users_id,
                                type: 3 // Observateur
                            }
                        };

                        const observerUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket_User/`;
                        await axios.post(observerUrl, observerPayload, { headers });
                    } catch (observerError) {
                        console.error("Erreur lors de l'ajout d'observateur");
                    }
                }
            }
            if (existingGroupAssignments.data && Array.isArray(existingGroupAssignments.data)) {
                const groupAssignmentsToRemove = existingGroupAssignments.data.filter(assignment =>
                    assignment.type === 2 && assignment.groups_id != currentGroupId
                );

                for (const assignment of groupAssignmentsToRemove) {
                    try {
                        const deleteUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Group_Ticket/`;
                        const deletePayload = {
                            input: { id: assignment.id },
                            force_purge: true
                        };

                        await axios.delete(deleteUrl, { headers, data: deletePayload });
                    } catch (deleteError) {
                        console.error("Erreur lors de la suppression d'assignation groupe");
                    }
                }
            }

            // Assigner le nouvel utilisateur si nécessaire
            if (currentUserId) {
                const isAlreadyAssigned = existingAssignments.data && Array.isArray(existingAssignments.data) ?
                    existingAssignments.data.some(a => a.users_id == currentUserId && a.type === 2) : false;

                if (!isAlreadyAssigned) {
                    try {
                        const assignPayload = {
                            input: {
                                tickets_id: ticketId,
                                users_id: currentUserId,
                                type: 2 // Assigné
                            }
                        };

                        const assignUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket_User/`;
                        await axios.post(assignUrl, assignPayload, { headers });
                    } catch (assignError) {
                        console.error("Erreur lors de l'assignation");
                    }
                }
            }

            // Ajouter l'observateur si spécifié
            if (input.ticketUpdate.users_id_observer) {
                const existingObservers = existingAssignments.data && Array.isArray(existingAssignments.data) ?
                    existingAssignments.data.filter(a => a.users_id == input.ticketUpdate.users_id_observer && a.type === 3) : [];

                if (existingObservers.length === 0) {
                    try {
                        const observerPayload = {
                            input: {
                                tickets_id: ticketId,
                                users_id: input.ticketUpdate.users_id_observer,
                                type: 3 // Observateur
                            }
                        };

                        const observerUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket_User/`;
                        await axios.post(observerUrl, observerPayload, { headers });
                    } catch (observerError) {
                        console.error("Erreur lors de l'ajout d'observateur");
                    }
                }
            }

            // Ajouter une validation si nécessaire
            if (input.ticketValidation) {
                const validationUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/TicketValidation/`;
                const validationInput = input.ticketValidation.input;

                // Si un groupe est assigné au ticket ET qu'aucun utilisateur individuel n'est assigné,
                // récupérer tous les membres et créer une validation pour chacun
                if (currentGroupId && !currentUserId) {
                    console.log(`Groupe assigné: ${currentGroupId}. Récupération des membres pour validation...`);

                    // Récupération des membres du groupe via l'API GLPI
                    let groupMembers = [];
                    try {
                        const groupUsersUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Group/${currentGroupId}/Group_User/`;
                        const groupResponse = await axios.get(groupUsersUrl, { headers });

                        if (groupResponse.status === 200 && groupResponse.data) {
                            groupMembers = groupResponse.data
                                .filter(item => item.users_id)
                                .map(item => item.users_id);
                            console.log(`Membres du groupe ${currentGroupId}:`, groupMembers);
                        }
                    } catch (groupError) {
                        console.error(`Erreur lors de la récupération des membres du groupe:`, groupError.message);
                    }

                    if (groupMembers.length > 0) {
                        console.log(`Création de ${groupMembers.length} demandes de validation pour les membres du groupe`);

                        // Créer une demande de validation pour chaque membre du groupe
                        for (const userId of groupMembers) {
                            const validationPayload = {
                                input: {
                                    tickets_id: ticketId,
                                    users_id_validate: userId,
                                    comment_submission: validationInput.comment_submission || "Validation requise par le groupe",
                                    validation_status: 2
                                }
                            };

                            try {
                                const validationResponse = await axios.post(validationUrl, validationPayload, { headers });
                                console.log(`Validation créée pour l'utilisateur ${userId}, ID: ${validationResponse.data.id}`);
                            } catch (validationError) {
                                console.error(`Erreur lors de la création de la validation pour l'utilisateur ${userId}:`, validationError.message);
                            }
                        }
                    } else {
                        console.log("Aucun membre trouvé dans le groupe, pas de validation créée");
                    }
                } else {
                         // Validation par le tech assigné dynamiquement
                         const assignedTech = existingAssignments.data && Array.isArray(existingAssignments.data)
                                ? existingAssignments.data.find(a => a.type === 2)
                                : null;
                        if (assignedTech) {
                                try {
                                        const validationPayload = {
                                                input: {
                                                        tickets_id: ticketId,
                                                        users_id_validate: assignedTech.users_id,
                                                        comment_submission: validationInput.comment_submission,
                                                }
                                        };
                                        await axios.post(validationUrl, validationPayload, { headers });
                                        console.log("Validation créée pour le tech:", assignedTech.users_id);
                                } catch (validationError) {
                                        console.error("Erreur lors de l'ajout de validation:", validationError.message);
                                }
                        } else {
                                console.log("Aucun tech assigné, validation non créée");
                        }
                }
            }

            console.log("Fin de la tâche de mise à jour du ticket");

            // Stockage de l'ID du ticket pour les tâches suivantes
            if (context && context.item && context.item.data) {
                context.item.data.ticketId = ticketId;
            }

            return { ticketId };
        } catch (error) {
            console.error("Erreur lors de la mise à jour du ticket");
            return { error: "Échec de la mise à jour du ticket" };
        }
    }

    async killSession(input, context) {
        console.log("Début de la fonction killSession");

        const initSessionUrl = process.env.ITSM_HOST + process.env.ITSM_URI + "/apirest.php/initSession";
        const appToken = process.env.ITSM_APP_TOKEN;

        try {
            // Créer une nouvelle session
            const sessionResponse = await axios.get(initSessionUrl, {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "user_token " + process.env.ITSM_USER_TOKEN,
                    "App-Token": appToken,
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache"
                },
            });

            if (sessionResponse.status === 200 && sessionResponse.data && sessionResponse.data.session_token) {
                const sessionToken = sessionResponse.data.session_token;

                const headers = {
                    "Content-Type": "application/json",
                    "Session-Token": sessionToken,
                    "App-Token": appToken,
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache"
                };

                // Réinitialiser le profil
                try {
                    const getActiveProfileUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/getActiveProfile/`;
                    const profileResponse = await axios.get(getActiveProfileUrl, { headers });

                    if (profileResponse.data.id !== 1) {
                        const resetProfileUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/changeActiveProfile/`;
                        await axios.post(resetProfileUrl, { profiles_id: 1 }, { headers });
                    }
                } catch (profileError) {
                    console.error("Erreur lors du changement de profil");
                }

                // Tuer la session avec la méthode qui fonctionne
                try {
                    const killSessionUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/killSession/`;
                    await axios.get(killSessionUrl, { headers });
                    console.log("Session terminée avec succès");
                    return { success: true };
                } catch (killError) {
                    console.error("Erreur lors de la terminaison de session:", killError.message);
                    return { success: false, error: "Échec de terminaison de session" };
                }
            } else {
                return { success: false, error: "Échec de récupération du token de session" };
            }
        } catch (error) {
            console.error("Erreur lors de l'exécution de killSession:", error.message);
            return { success: false, error: error.message };
        } finally {
            console.log("Fin de la fonction killSession");
        }
    }

    async closeTicket(input, context) {
        const ticketId = input.ticketId || context.item.data.ticketId;

        if (!ticketId) {
            return { error: "ID de ticket manquant" };
        }

        console.log("Début de la tâche de fermeture de ticket");

        const initSessionUrl = process.env.ITSM_HOST + process.env.ITSM_URI + "/apirest.php/initSession";
        const updateTicketUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket/${ticketId}`;
        const appToken = process.env.ITSM_APP_TOKEN;

        try {
            const sessionResponse = await axios.get(initSessionUrl, {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "user_token " + process.env.ITSM_USER_TOKEN,
                    "App-Token": appToken,
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache"
                },
            });

            if (sessionResponse.status === 200 && sessionResponse.data && sessionResponse.data.session_token) {
                const sessionToken = sessionResponse.data.session_token;

                const headers = {
                    "Content-Type": "application/json",
                    "Session-Token": sessionToken,
                    "App-Token": appToken,
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache"
                };

                // Passer en profil superadmin
                const getActiveProfileUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/getActiveProfile/`;
                const profileResponse = await axios.get(getActiveProfileUrl, { headers });

                if (profileResponse.data.id !== 4) {
                    const changeProfileUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/changeActiveProfile/`;
                    await axios.post(changeProfileUrl, { profiles_id: 4 }, { headers });
                }

                // Clôture du ticket
                const closedPayload = {
                    input: {
                        status: 6
                    }
                };

                const ticketResponse = await axios.put(updateTicketUrl, closedPayload, { headers });

                if (ticketResponse.status === 200) {
                    console.log("Ticket clos avec succès, ID:", ticketId);
                    context.item.data.ticket_closed = true;

                    return {
                        success: true,
                        ticketId: ticketId,
                        ticket_closed: true
                    };
                } else {
                    return {
                        error: "Échec de la fermeture du ticket"
                    };
                }
            } else {
                return {
                    error: "Échec de récupération du token de session"
                };
            }
        } catch (error) {
            console.error("Erreur lors de la fermeture du ticket:", error.message);
            return {
                error: "Erreur de communication avec l'API: " + error.message
            };
        } finally {
            console.log("Fin de la tâche de fermeture de ticket");
        }
    }

    async raiseBPMNError(input, context) {
        return { bpmnError: ' Something went wrong' };
    }

    async getUserName(input, context) {
        const userId = input.userId;

        if (!userId) {
            return { error: "ID utilisateur manquant" };
        }

        console.log("Début de la récupération du nom d'utilisateur pour l'ID:", userId);

        const initSessionUrl = process.env.ITSM_HOST + process.env.ITSM_URI + "/apirest.php/initSession";
        const userApiUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/User/${userId}`;
        const appToken = process.env.ITSM_APP_TOKEN;

        try {
            const sessionResponse = await axios.get(initSessionUrl, {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "user_token " + process.env.ITSM_USER_TOKEN,
                    "App-Token": appToken,
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache"
                },
            });

            if (sessionResponse.status === 200 && sessionResponse.data && sessionResponse.data.session_token) {
                const sessionToken = sessionResponse.data.session_token;

                const headers = {
                    "Content-Type": "application/json",
                    "Session-Token": sessionToken,
                    "App-Token": appToken,
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache"
                };

                // Récupérer les informations de l'utilisateur
                const userResponse = await axios.get(userApiUrl, { headers });

                if (userResponse.status === 200 && userResponse.data) {
                    const user = userResponse.data;
                    console.log("DEBUG FULL USER OBJECT:", JSON.stringify(user)); // Log complet pour voir les champs disponibles
                    // Utilisation de 'name' si firstname/realname sont vides (cas observé pour l'ID 6)
                    const userName = `${user.firstname || ''} ${user.realname || ''}`.trim() || user.name || `Utilisateur ${userId}`;

                    console.log("Nom d'utilisateur récupéré:", userName);

                    // Stocker le nom dans le contexte pour utilisation ultérieure
                    if (context && context.item && context.item.data) {
                        context.item.data[`userName_${userId}`] = userName;
                        context.item.data['agentName'] = userName; // Stockage simplifié
                        console.log(`DEBUG: userName_${userId} set to '${userName}'`);
                        console.log(`DEBUG: agentName set to '${userName}'`);
                    }

                    return {
                        userName: userName,
                        firstname: user.firstname,
                        realname: user.realname
                    };
                } else {
                    return {
                        error: "Utilisateur non trouvé",
                        userName: `Utilisateur ${userId}`
                    };
                }
            } else {
                return {
                    error: "Échec de récupération du token de session",
                    userName: `Utilisateur ${userId}`
                };
            }
        } catch (error) {
            console.error("Erreur lors de la récupération du nom d'utilisateur:", error.message);
            return {
                error: "Erreur de communication avec l'API: " + error.message,
                userName: `Utilisateur ${userId}`
            };
        } finally {
            console.log("Fin de la récupération du nom d'utilisateur");
        }
    }

    async getGroupMembers(groupId: number, sessionToken: string, appToken: string): Promise<number[]> {
        try {
            const headers = {
                "Content-Type": "application/json",
                "Session-Token": sessionToken,
                "App-Token": appToken,
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Pragma": "no-cache"
            };

            const groupUsersUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Group/${groupId}/Group_User/`;
            console.log(`Récupération des membres du groupe ${groupId}`);

            const response = await axios.get(groupUsersUrl, { headers });

            if (response.status === 200 && response.data) {
                // Extraire les IDs des utilisateurs du groupe
                const userIds = response.data
                    .filter(item => item.users_id)
                    .map(item => item.users_id);

                console.log(`Membres du groupe ${groupId}:`, userIds);
                return userIds;
            } else {
                console.log(`Aucun membre trouvé pour le groupe ${groupId}`);
                return [];
            }
        } catch (error) {
            console.error(`Erreur lors de la récupération des membres du groupe ${groupId}:`, error.message);
            return [];
        }
    }

    async logFormFields(input, context) {
        console.log("--------------- DEBUG LOG FORM FIELDS ---------------");
        if (context.item && context.item.data) {
            const data = context.item.data;
            const keys = Object.keys(data).sort();

            console.log("Full Data Context Keys:", keys.join(', '));

            let found = false;
            keys.forEach(key => {
                if (key.startsWith('formcreator_field_')) {
                    console.log(`Field [${key}]:`, data[key]);
                    found = true;
                }
            });

            if (!found) {
                console.log("Aucun champ 'formcreator_field_' trouvé dans le contexte.");
            }
        } else {
            console.log("No context data found.");
        }
        console.log("-----------------------------------------------------");
        return { logged: true };
    }

    /**
     * Récupère les métadonnées des questions FormCreator depuis l'API GLPI.
     */
    static async fetchFormCreatorMetadata(formId: number, sessionToken: string, appToken: string): Promise<{
        questions: Record<string, { name: string; sectionId: number; sectionName: string; order: number; fieldtype: string; itemtype: string }>;
        sections: Record<number, { name: string; order: number }>;
    }> {
        const baseUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php`;
        const headers = {
            "Content-Type": "application/json",
            "Session-Token": sessionToken,
            "App-Token": appToken,
        };

        const result = {
            questions: {} as Record<string, { name: string; sectionId: number; sectionName: string; order: number; fieldtype: string; itemtype: string }>,
            sections: {} as Record<number, { name: string; order: number }>
        };

        try {
            const sectionsResponse = await axios.get(`${baseUrl}/PluginFormcreatorSection?range=0-200`, { headers });
            const allSections = sectionsResponse.data || [];
            const formSections = allSections.filter((s: any) => s.plugin_formcreator_forms_id === formId);
            for (const section of formSections) {
                result.sections[section.id] = { name: section.name, order: section.order || 0 };
            }

            const questionsResponse = await axios.get(`${baseUrl}/PluginFormcreatorQuestion?range=0-500`, { headers });
            const allQuestions = questionsResponse.data || [];
            const sectionIds = Object.keys(result.sections).map(Number);
            for (const question of allQuestions) {
                if (sectionIds.includes(question.plugin_formcreator_sections_id)) {
                    // Extraire l'itemtype depuis le champ values (JSON string) pour les dropdowns
                    let itemtype = question.itemtype || '';
                    if (!itemtype && question.values) {
                        try {
                            const parsedValues = JSON.parse(question.values);
                            if (parsedValues && parsedValues.itemtype) {
                                itemtype = parsedValues.itemtype;
                            }
                        } catch (e) {
                            // values n'est pas un JSON valide (ex: tableau de valeurs radio)
                        }
                    }

                    result.questions[question.id.toString()] = {
                        name: question.name,
                        sectionId: question.plugin_formcreator_sections_id,
                        sectionName: result.sections[question.plugin_formcreator_sections_id]?.name || '',
                        order: question.row || 0,
                        fieldtype: question.fieldtype || '',
                        itemtype: itemtype
                    };
                }
            }
            console.log(`FormCreator metadata: ${Object.keys(result.questions).length} questions, ${Object.keys(result.sections).length} sections`);
        } catch (error) {
            console.error("Erreur lors de la récupération des métadonnées FormCreator:", error.message);
        }

        return result;
    }

    /**
     * Résout un ID en nom lisible via l'API GLPI.
     */
    static async resolveGlpiItemName(itemtype: string, itemId: number, sessionToken: string, appToken: string): Promise<string> {
        if (!itemtype || !itemId || itemId === 0) return String(itemId);

        const baseUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php`;
        const headers = {
            "Content-Type": "application/json",
            "Session-Token": sessionToken,
            "App-Token": appToken,
        };

        try {
            const response = await axios.get(`${baseUrl}/${itemtype}/${itemId}`, { headers });
            if (response.status === 200 && response.data) {
                const item = response.data;
                // Selon le type d'objet, retourner le champ approprié
                if (itemtype === 'User') {
                    return `${item.firstname || ''} ${item.realname || ''}`.trim() || item.name || String(itemId);
                }
                return item.name || item.completename || String(itemId);
            }
        } catch (error) {
            console.error(`Erreur lors de la résolution de ${itemtype}/${itemId}:`, error.message);
        }
        return String(itemId);
    }

    /**
     * Génère le contenu HTML formaté du formulaire avec sections et labels.
     * Résout les IDs des dropdowns en noms lisibles.
     */
    static async generateFormattedHtmlContent(
        data: any,
        metadata: {
            questions: Record<string, { name: string; sectionId: number; sectionName: string; order: number; fieldtype: string; itemtype: string }>;
            sections: Record<number, { name: string; order: number }>;
        },
        sessionToken: string,
        appToken: string
    ): Promise<string> {
        if (!data || !metadata) return '';

        const htmlParts: string[] = [];
        const sortedSections = Object.entries(metadata.sections).sort(([, a], [, b]) => a.order - b.order);

        // Types de champs qui référencent des objets GLPI
        const dropdownFieldTypes = ['dropdown', 'glpiselect', 'dropdownfield'];

        for (const [sectionId, section] of sortedSections) {
            const sectionIdNum = parseInt(sectionId);
            const sectionQuestions = Object.entries(metadata.questions)
                .filter(([, q]) => q.sectionId === sectionIdNum)
                .sort(([, a], [, b]) => a.order - b.order);

            if (sectionQuestions.length === 0) continue;

            const hasValues = sectionQuestions.some(([qId]) => {
                const value = data[`formcreator_field_${qId}`];
                return value !== undefined && value !== null && value !== '';
            });

            if (!hasValues) continue;

            htmlParts.push(`<h3><b>${section.name}</b></h3>`);

            for (const [questionId, question] of sectionQuestions) {
                const value = data[`formcreator_field_${questionId}`];
                if (value === undefined || value === null || value === '') continue;

                let formattedValue: string;

                // Si c'est un dropdown avec un itemtype, résoudre l'ID en nom
                if (dropdownFieldTypes.includes(question.fieldtype) && question.itemtype && !isNaN(Number(value))) {
                    formattedValue = await AppServices.resolveGlpiItemName(
                        question.itemtype,
                        Number(value),
                        sessionToken,
                        appToken
                    );
                } else if (Array.isArray(value)) {
                    formattedValue = value.join(', ');
                } else {
                    formattedValue = String(value);
                }

                htmlParts.push(`<p><b>${question.name}</b> : ${formattedValue}</p>`);
            }
        }

        return htmlParts.join('\n');
    }
}
export { AppServices }
