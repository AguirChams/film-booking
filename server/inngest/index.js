import { Inngest } from "inngest";
import User from "../models/User.js";
import Booking from "../models/Booking.js";
import Show from "../models/Show.js";
import sendEmail from "../configs/nodeMailer.js";

// 1. IL MANQUAIT CETTE LIGNE : Créer et exporter l'instance client
export const inngest = new Inngest({ id: "film-booking-app" });

// Inngest Function to save user data to a database
const syncUserCreation = inngest.createFunction(
    { id: 'sync-user-from-clerk' },
    { event: 'clerk/user.created' },
    async ({ event }) => {
        const { id, first_name, last_name, email_addresses, image_url } = event.data
        const userData = {
            _id: id,
            email: email_addresses[0].email_address,
            name: first_name + ' ' + last_name,
            image: image_url
        }
        await User.create(userData)
    }
)

// Inngest Function to delete user from database
const syncUserDeletion = inngest.createFunction(
    { id: 'delete-user-with-clerk' },
    { event: 'clerk/user.deleted' },
    async ({ event }) => {
        const { id } = event.data
        await User.findByIdAndDelete(id)
    }
)

// Inngest Function to update user data in database 
const syncUserUpdation = inngest.createFunction(
    { id: 'update-user-from-clerk' },
    { event: 'clerk/user.updated' },
    async ({ event }) => {
        const { id, first_name, last_name, email_addresses, image_url } = event.data
        const userData = {
            _id: id,
            email: email_addresses[0].email_address,
            name: first_name + ' ' + last_name,
            image: image_url
        }
        await User.findByIdAndUpdate(id, userData)
    }
)

// Inngest Function to cancel booking
const releaseSeatsAndDeleteBooking = inngest.createFunction(
    { id: 'release-seats-delete-booking' },
    { event: "app/checkpayment" },
    async ({ event, step }) => {
        const tenMinutesLater = new Date(Date.now() + 10 * 60 * 1000);
        await step.sleepUntil('wait-for-10-minutes', tenMinutesLater);

        await step.run('check-payment-status', async () => {
            const bookingId = event.data.bookingId;
            const booking = await Booking.findById(bookingId)

            if (booking && !booking.isPaid) {
                const show = await Show.findById(booking.show);
                booking.bookedSeats.forEach((seat) => {
                    delete show.occupiedSeats[seat]
                });
                show.markModified('occupiedSeats')
                await show.save()
                await Booking.findByIdAndDelete(booking._id)
            }
        })
    }
)

// Inngest Function to send email
const sendBookingConfirmationEmail = inngest.createFunction(
    { id: "send-booking-confirmation-email" },
    { event: "app/show.booked" },
    async ({ event, step }) => {
        const { bookingId } = event.data;

        const booking = await Booking.findById(bookingId).populate({
            path: 'show',
            populate: { path: "movie", model: "Movie" }
        }).populate('user');

        await sendEmail({
            to: booking.user.email,
            subject: `Payment Confirmation: "${booking.show.movie.title}" booked!`,
            body: `<div style="font-family: Arial, sans-serif; line-height: 1.5;">
                        <h2>Hi ${booking.user.name},</h2>
                        <p>Your booking for <strong style="color: #F84565;">"${booking.show.movie.title}"</strong> is confirmed.</p>
                        <p>Enjoy the show! 🍿</p>
                    </div>`
        })
    }
)

// Inngest Function to send reminders
const sendShowReminders = inngest.createFunction(
    { id: "send-show-reminders" },
    { cron: "0 */8 * * *" },
    async ({ step }) => {
        const now = new Date();
        const in8Hours = new Date(now.getTime() + 8 * 60 * 60 * 1000);
        const windowStart = new Date(in8Hours.getTime() - 10 * 60 * 1000);

        const reminderTasks = await step.run("prepare-reminder-tasks", async () => {
            const shows = await Show.find({
                showTime: { $gte: windowStart, $lte: in8Hours },
            }).populate('movie');

            const tasks = [];
            for (const show of shows) {
                if (!show.movie || !show.occupiedSeats) continue;
                const userIds = [...new Set(Object.values(show.occupiedSeats))];
                const users = await User.find({ _id: { $in: userIds } }).select("name email");
                for (const user of users) {
                    tasks.push({
                        userEmail: user.email,
                        userName: user.name,
                        movieTitle: show.movie.title,
                        showTime: show.showTime,
                    })
                }
            }
            return tasks;
        })

        if (reminderTasks.length > 0) {
            await step.run('send-all-reminders', async () => {
                return await Promise.allSettled(
                    reminderTasks.map(task => sendEmail({
                        to: task.userEmail,
                        subject: `Reminder: "${task.movieTitle}" starts soon!`,
                        body: `Hi ${task.userName}, your movie starts in 8 hours!`
                    }))
                )
            })
        }
    }
)

// Inngest Function to send notifications
const sendNewShowNotifications = inngest.createFunction(
    { id: "send-new-show-notifications" },
    { event: "app/show.added" },
    async ({ event }) => {
        const { movieTitle } = event.data;
        const users = await User.find({})
        for (const user of users) {
            await sendEmail({
                to: user.email,
                subject: `🎬 New Show Added: ${movieTitle}`,
                body: `Hi ${user.name}, we've added "${movieTitle}"!`
            })
        }
        return { message: "Notifications sent." }
    }
)

// Exportation finale pour le handler Vercel
export const functions = [
    syncUserCreation,
    syncUserDeletion,
    syncUserUpdation,
    releaseSeatsAndDeleteBooking,
    sendBookingConfirmationEmail,
    sendShowReminders,
    sendNewShowNotifications
];