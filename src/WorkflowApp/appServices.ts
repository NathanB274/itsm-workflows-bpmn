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

                        if (ticketContent.groups_id_assign) {
                            console.log(`Groupe assigné: ${ticketContent.groups_id_assign}. Récupération des membres...`);

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
                            if (ticket.status === 6) {
                                context.item.data.ticket_closed = true;
                                return { validated: true, ticket_closed: true };
                            }

                            const globalValidationStatus = ticket.global_validation;
                            console.log(`Ticket ${ticketId}, Validation globale = ${globalValidationStatus}`);

                            let hasNewRejection = false;
                            let rejectionUserName = "";
                            let hasNewApproval = false;
                            let approvalUserId = null;

                            if (validationsResponse.status === 200 && Array.isArray(validationsResponse.data)) {
                                for (const validation of validationsResponse.data) {
                                    const alreadySeen = context.item.data.seenValidations.includes(validation.id);

                                    if (validation.status === 4 && !alreadySeen) {
                                        hasNewRejection = true;
                                        rejectionUserName = validation.users_id_validate;
                                        context.item.data.seenValidations.push(validation.id);
                                        context.item.data.rejectedBy = validation.users_id_validate;
                                        break;
                                    } else if (validation.status === 3 && !alreadySeen) {
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
                                console.log(`Assignation automatique du ticket à l'utilisateur ${approvalUserId} qui a validé`);

                                try {
                                    const ticketUsersUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket/${ticketId}/Ticket_User`;
                                    const existingAssignments = await axios.get(ticketUsersUrl, { headers });

                                    const isAlreadyAssigned = existingAssignments.data && Array.isArray(existingAssignments.data) ?
                                        existingAssignments.data.some(a => a.users_id == approvalUserId && a.type === 2) : false;

                                    if (!isAlreadyAssigned) {
                                        const assignPayload = {
                                            input: {
                                                tickets_id: ticketId,
                                                users_id: approvalUserId,
                                                type: 2
                                            }
                                        };

                                        const assignUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket_User/`;
                                        await axios.post(assignUrl, assignPayload, { headers });
                                        console.log(`Utilisateur ${approvalUserId} assigné au ticket ${ticketId} avec succès`);

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

                const getActiveProfileUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/getActiveProfile/`;
                const profileResponse = await axios.get(getActiveProfileUrl, { headers });

                if (profileResponse.data.id !== 4) {
                    const changeProfileUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/changeActiveProfile/`;
                    await axios.post(changeProfileUrl, { profiles_id: 4 }, { headers });
                }

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

                const getActiveProfileUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/getActiveProfile/`;
                const profileResponse = await axios.get(getActiveProfileUrl, { headers });

                if (profileResponse.data.id !== 4) {
                    const changeProfileUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/changeActiveProfile/`;
                    await axios.post(changeProfileUrl, { profiles_id: 4 }, { headers });
                }

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
                    context.item.data.lastTaskId = taskResponse.data.id;
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
        const interval = 10000;
        let attempts = 0;

        let headers = null;
        try {
            const sessionResponse = await axios.get(`${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/initSession`, {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "user_token " + process.env.ITSM_USER_TOKEN,
                    "App-Token": appToken,
                }
            });

            if (!sessionResponse.data.session_token) {
                return { error: "Échec de récupération du token de session" };
            }

            headers = {
                "Content-Type": "application/json",
                "Session-Token": sessionResponse.data.session_token,
                "App-Token": appToken,
            };
        } catch (error) {
            return { error: "Erreur initSession: " + error.message };
        }

        while (attempts < maxAttempts) {
            try {
                const usersResponse = await axios.get(ticketUsersUrl, { headers });

                if (usersResponse.status === 200 && Array.isArray(usersResponse.data)) {
                    const assignedTech = usersResponse.data.find(a => a.type === 2);

                    if (assignedTech) {
                        console.log("Tech assigné trouvé:", assignedTech.users_id);
                        context.item.data.assignedTechId = assignedTech.users_id;
                        return { success: true, assignedTechId: assignedTech.users_id };
                    }
                }
            } catch (error) {
                if (error.response && error.response.status === 401) {
                    console.log("Session expirée, renouvellement...");
                    try {
                        const sessionResponse = await axios.get(`${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/initSession`, {
                            headers: {
                                "Content-Type": "application/json",
                                "Authorization": "user_token " + process.env.ITSM_USER_TOKEN,
                                "App-Token": appToken,
                            }
                        });
                        headers["Session-Token"] = sessionResponse.data.session_token;
                    } catch (renewError) {
                        console.error("Erreur renouvellement session:", renewError.message);
                    }
                } else {
                    console.error("Erreur pollAssignment:", error.message);
                }
            }

            attempts++;
            await new Promise(resolve => setTimeout(resolve, interval));
        }

        return { error: "Timeout: aucun tech assigné", success: false };
    }

    async pollTaskCompletion(input, context) {
        const taskId = input.taskId || context.item.data.lastTaskId;

        if (!taskId) {
            return { error: "ID de tâche manquant" };
        }

        const appToken = process.env.ITSM_APP_TOKEN;
        const maxAttempts = 10000;
        const interval = 10000;
        let attempts = 0;

        let headers = null;
        try {
            const sessionResponse = await axios.get(`${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/initSession`, {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "user_token " + process.env.ITSM_USER_TOKEN,
                    "App-Token": appToken,
                }
            });

            if (!sessionResponse.data.session_token) {
                return { error: "Échec de récupération du token de session" };
            }

            headers = {
                "Content-Type": "application/json",
                "Session-Token": sessionResponse.data.session_token,
                "App-Token": appToken,
            };
        } catch (error) {
            return { error: "Erreur initSession: " + error.message };
        }

        while (attempts < maxAttempts) {
            try {
                const taskResponse = await axios.get(
                    `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/TicketTask/${taskId}`,
                    { headers }
                );

                if (taskResponse.status === 200 && taskResponse.data) {
                    const state = taskResponse.data.state;
                    console.log(`pollTaskCompletion: tâche ${taskId} state=${state}`);

                    if (state === 2) {
                        console.log(`Tâche ${taskId} terminée`);
                        return { success: true, taskId, completed: true };
                    }
                }
            } catch (error) {
                if (error.response && error.response.status === 401) {
                    try {
                        const sessionResponse = await axios.get(`${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/initSession`, {
                            headers: {
                                "Content-Type": "application/json",
                                "Authorization": "user_token " + process.env.ITSM_USER_TOKEN,
                                "App-Token": appToken,
                            }
                        });
                        headers["Session-Token"] = sessionResponse.data.session_token;
                    } catch (renewError) {
                        console.error("Erreur renouvellement session:", renewError.message);
                    }
                } else {
                    console.error("Erreur pollTaskCompletion:", error.message);
                }
            }

            attempts++;
            await new Promise(resolve => setTimeout(resolve, interval));
        }

        return { error: "Timeout: tâche non terminée", success: false };
    }

    async assignItemToUser(input, context) {
        const taskId = context.item.data.lastTaskId;
        const matricule = input.matricule || context.item.data.matricule;

        if (!taskId || !matricule) {
            return { error: "taskId ou matricule manquant" };
        }

        const appToken = process.env.ITSM_APP_TOKEN;

        try {
            const sessionResponse = await axios.get(`${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/initSession`, {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "user_token " + process.env.ITSM_USER_TOKEN,
                    "App-Token": appToken,
                }
            });

            const sessionToken = sessionResponse.data.session_token;
            const headers = {
                "Content-Type": "application/json",
                "Session-Token": sessionToken,
                "App-Token": appToken,
            };

            await axios.post(`${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/changeActiveProfile/`,
                { profiles_id: 4 }, { headers });

            const ticketId = context.item.data.ticketId;
            const itemTicketResponse = await axios.get(
                `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket/${ticketId}/Item_Ticket`,
                { headers }
            );
            if (!itemTicketResponse.data || !Array.isArray(itemTicketResponse.data) || itemTicketResponse.data.length === 0) {
                console.log("Aucun item associé au ticket");
                return { success: false, error: "Aucun item associé" };
            }
            const itemId   = itemTicketResponse.data[0].items_id;
            const itemType = itemTicketResponse.data[0].itemtype;
            console.log(`Item trouvé: ${itemType} id=${itemId}`);

            const userResponse = await axios.get(
                `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/User`,
                { headers, params: { "searchText[name]": matricule, "range": "0-1" } }
            );

            if (!userResponse.data || userResponse.data.length === 0) {
                console.error(`Utilisateur non trouvé pour matricule: ${matricule}`);
                return { success: false, error: "Utilisateur non trouvé" };
            }

            const userId = userResponse.data[0].id;
            console.log(`Utilisateur trouvé: ${userId} pour matricule ${matricule}`);

            await axios.put(
                `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/${itemType}/${itemId}`,
                {
                    input: {
                        users_id: userId,
                        ...(input.states_id && { states_id: input.states_id }),
                        ...(context.item.data.resolvedLocationId && { locations_id: context.item.data.resolvedLocationId })
                    }
                },
                { headers }
            );

            console.log(`${itemType} ${itemId} attribué à l'utilisateur ${userId}`);
            return { success: true, itemId, itemType, userId };

        } catch (error) {
            console.error("Erreur assignItemToUser:", error.message);
            return { error: error.message };
        }
    }

    async updateTicket(input, context) {
        try {
            const ticketId = input.ticketUpdate.id;
            const appToken = process.env.ITSM_APP_TOKEN;

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

            try {
                const changeProfileUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/changeActiveProfile/`;
                await axios.post(changeProfileUrl, { profiles_id: 4 }, { headers });
            } catch (profileError) {
                console.error("Erreur lors du changement de profil");
            }

            const ticketUsersUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket/${ticketId}/Ticket_User`;
            const existingAssignments = await axios.get(ticketUsersUrl, { headers });

            const ticketGroupsUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket/${ticketId}/Group_Ticket`;
            const existingGroupAssignments = await axios.get(ticketGroupsUrl, { headers });

            const currentUserId = input.ticketUpdate.users_id_assign;
            const currentGroupId = input.ticketUpdate.groups_id_assign;

            if (existingAssignments.data && Array.isArray(existingAssignments.data)) {
                const assignmentsToRemove = existingAssignments.data.filter(assignment =>
                    assignment.type === 2 && assignment.users_id != currentUserId
                );

                for (const assignment of assignmentsToRemove) {
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

                    try {
                        const observerPayload = {
                            input: {
                                tickets_id: ticketId,
                                users_id: assignment.users_id,
                                type: 3
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

            if (currentGroupId) {
                const isGroupAlreadyAssigned = existingGroupAssignments.data && Array.isArray(existingGroupAssignments.data) ?
                    existingGroupAssignments.data.some(a => a.groups_id == currentGroupId && a.type === 2) : false;
                if (!isGroupAlreadyAssigned) {
                    try {
                        const groupAssignPayload = {
                            input: {
                                tickets_id: ticketId,
                                groups_id: currentGroupId,
                                type: 2
                            }
                        };
                        const groupAssignUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Group_Ticket/`;
                        await axios.post(groupAssignUrl, groupAssignPayload, { headers });
                        console.log(`Groupe ${currentGroupId} assigné au ticket ${ticketId}`);
                    } catch (groupAssignError) {
                        console.error("Erreur lors de l'assignation du groupe:", groupAssignError.message);
                    }
                }
            }

            if (currentUserId) {
                const isAlreadyAssigned = existingAssignments.data && Array.isArray(existingAssignments.data) ?
                    existingAssignments.data.some(a => a.users_id == currentUserId && a.type === 2) : false;

                if (!isAlreadyAssigned) {
                    try {
                        const assignPayload = {
                            input: {
                                tickets_id: ticketId,
                                users_id: currentUserId,
                                type: 2
                            }
                        };
                        const assignUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket_User/`;
                        await axios.post(assignUrl, assignPayload, { headers });
                    } catch (assignError) {
                        console.error("Erreur lors de l'assignation");
                    }
                }
            }

            if (input.ticketUpdate.users_id_observer) {
                const existingObservers = existingAssignments.data && Array.isArray(existingAssignments.data) ?
                    existingAssignments.data.filter(a => a.users_id == input.ticketUpdate.users_id_observer && a.type === 3) : [];

                if (existingObservers.length === 0) {
                    try {
                        const observerPayload = {
                            input: {
                                tickets_id: ticketId,
                                users_id: input.ticketUpdate.users_id_observer,
                                type: 3
                            }
                        };
                        const observerUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket_User/`;
                        await axios.post(observerUrl, observerPayload, { headers });
                    } catch (observerError) {
                        console.error("Erreur lors de l'ajout d'observateur");
                    }
                }
            }

            if (input.ticketValidation) {
                const validationUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/TicketValidation/`;
                const validationInput = input.ticketValidation.input;

                if (currentGroupId && !currentUserId) {
                    console.log(`Groupe assigné: ${currentGroupId}. Récupération des membres pour validation...`);

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

            if (input.ticketUpdate.manager_email) {
                try {
                    const userSearchUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/UserEmail`;
                    const userSearchResponse = await axios.get(userSearchUrl, {
                        headers,
                        params: { "searchText[email]": input.ticketUpdate.manager_email, "range": "0-1" }
                    });
                    if (userSearchResponse.data && userSearchResponse.data.length > 0) {
                        const managerId = userSearchResponse.data[0].users_id;
                        const ticketUsersUrl2 = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket/${ticketId}/Ticket_User`;
                        const currentRequesters = await axios.get(ticketUsersUrl2, { headers });
                        if (currentRequesters.data && Array.isArray(currentRequesters.data)) {
                            for (const requester of currentRequesters.data.filter(u => u.type === 1)) {
                                await axios.delete(`${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket_User/`, {
                                    headers,
                                    data: { input: { id: requester.id }, force_purge: true }
                                });
                            }
                        }
                        await axios.post(`${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket_User/`, {
                            input: { tickets_id: ticketId, users_id: managerId, type: 1 }
                        }, { headers });
                        console.log(`Demandeur mis à jour avec manager: ${managerId}`);
                    } else {
                        console.log(`Manager non trouvé pour email: ${input.ticketUpdate.manager_email}`);
                    }
                } catch (requesterError) {
                    console.error("Erreur résolution manager:", requesterError.message);
                }
            }

            if (input.ticketUpdate.status) {
                try {
                    await axios.put(`${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Ticket/${ticketId}`, {
                        input: {
                            status: input.ticketUpdate.status,
                            ...(input.ticketUpdate.global_validation !== undefined && { global_validation: input.ticketUpdate.global_validation })
                        }
                    }, { headers });
                    console.log(`Statut ticket mis à jour: ${input.ticketUpdate.status}`);
                } catch (statusError) {
                    console.error("Erreur mise à jour statut:", statusError.message);
                }
            }

            if (context && context.item && context.item.data) {
                context.item.data.ticketId = ticketId;
            }
            console.log("Fin de la tâche de mise à jour du ticket");

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

                const getActiveProfileUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/getActiveProfile/`;
                const profileResponse = await axios.get(getActiveProfileUrl, { headers });

                if (profileResponse.data.id !== 4) {
                    const changeProfileUrl = `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/changeActiveProfile/`;
                    await axios.post(changeProfileUrl, { profiles_id: 4 }, { headers });
                }

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

                const userResponse = await axios.get(userApiUrl, { headers });

                if (userResponse.status === 200 && userResponse.data) {
                    const user = userResponse.data;
                    console.log("DEBUG FULL USER OBJECT:", JSON.stringify(user));
                    const userName = `${user.firstname || ''} ${user.realname || ''}`.trim() || user.name || `Utilisateur ${userId}`;

                    console.log("Nom d'utilisateur récupéré:", userName);

                    if (context && context.item && context.item.data) {
                        context.item.data[`userName_${userId}`] = userName;
                        context.item.data['agentName'] = userName;
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
                    let itemtype = question.itemtype || '';
                    if (!itemtype && question.values) {
                        try {
                            const parsedValues = JSON.parse(question.values);
                            if (parsedValues && parsedValues.itemtype) {
                                itemtype = parsedValues.itemtype;
                            }
                        } catch (e) {
                            // values n'est pas un JSON valide
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

    async resolveUserByEmail(input, context) {
        const appToken = process.env.ITSM_APP_TOKEN;
        const email = input.email || context.item.data[input.emailField];

        if (!email) {
            console.error("resolveUserByEmail: aucun email fourni");
            return { error: "Email manquant" };
        }

        try {
            const sessionResponse = await axios.get(`${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/initSession`, {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "user_token " + process.env.ITSM_USER_TOKEN,
                    "App-Token": appToken,
                }
            });

            const sessionToken = sessionResponse.data.session_token;
            const headers = {
                "Content-Type": "application/json",
                "Session-Token": sessionToken,
                "App-Token": appToken,
            };

            await axios.post(`${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/changeActiveProfile/`,
                { profiles_id: 4 }, { headers });

            const response = await axios.get(
                `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/User`,
                {
                    headers,
                    params: { "searchText[email]": email, "range": "0-1" }
                }
            );

            if (!response.data || response.data.length === 0) {
                console.error(`resolveUserByEmail: aucun utilisateur trouvé pour ${email}`);
                return { error: "Utilisateur non trouvé", email };
            }

            const userId = response.data[0].id;
            const storeAs = input.storeAs || "resolvedUserId";
            context.item.data[storeAs] = userId;

            console.log(`resolveUserByEmail: ${email} → users_id ${userId} stocké dans data.${storeAs}`);
            return { success: true, userId, email };

        } catch (error) {
            console.error("resolveUserByEmail erreur:", error.message);
            return { error: error.message };
        }
    }

    async resolveLocation(input, context) {
        const locationName = input.locationName;

        if (!locationName) {
            return { error: "Nom de location manquant" };
        }

        const appToken = process.env.ITSM_APP_TOKEN;

        try {
            const sessionResponse = await axios.get(`${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/initSession`, {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "user_token " + process.env.ITSM_USER_TOKEN,
                    "App-Token": appToken,
                }
            });

            const sessionToken = sessionResponse.data.session_token;
            const headers = {
                "Content-Type": "application/json",
                "Session-Token": sessionToken,
                "App-Token": appToken,
            };

            const response = await axios.get(
                `${process.env.ITSM_HOST}${process.env.ITSM_URI}/apirest.php/Location`,
                {
                    headers,
                    params: { "searchText[name]": locationName, "range": "0-10" }
                }
            );

            if (response.data && response.data.length > 0) {
                const locationId = response.data[0].id;
                console.log(`Location résolue : "${locationName}" → id ${locationId}`);
                context.item.data.resolvedLocationId = locationId;
                return { success: true, locationId };
            } else {
                console.warn(`Aucune location trouvée pour : "${locationName}"`);
                return { error: "Location non trouvée", locationName };
            }

        } catch (error) {
            console.error("Erreur resolveLocation:", error.message);
            return { error: error.message };
        }
    }
}

export { AppServices }
