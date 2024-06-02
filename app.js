const express = require('express');
const session = require('express-session');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const credentials = require('./Key.json');
const { url } = require('inspector');

admin.initializeApp({
    credential: admin.credential.cert(credentials)
});
const db = admin.firestore();
const PORT = 9000;

const GOOGLE_BOOKS_API_KEY = 'AIzaSyBIAA2QVENxsxEd8sRPkB3NARacLTfonQE'

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'your_session_secret',
    resave: false,
    saveUninitialized: true
}));

app.get('/', (req, res) => {
    res.render('index');
});

app.post('/booksearch', async (req, res) => {
    const searchTerm = req.body.searchTerm;
    console.log('Search Term:', searchTerm);  

    try {
        const response = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(searchTerm)}&key=${GOOGLE_BOOKS_API_KEY}`);
        const data = await response.json();

        console.log('API Response:', data); 
        let books = [];
        if (data.items) {
            books = data.items.map(item => ({
                title: item.volumeInfo.title,
                author: item.volumeInfo.authors ? item.volumeInfo.authors.join(', ') : 'Unknown Author',
                cover: item.volumeInfo.imageLinks ? item.volumeInfo.imageLinks.thumbnail : '/path/to/default-cover.jpg',
                publishDate: item.volumeInfo.publishedDate,
                key: item.id,
                url: item.volumeInfo.infoLink
            }));
        }
        res.render('results', { books, searchTerm });
    } catch (error) {
        console.error('Error searching books:', error);
        res.status(500).send('Error searching books');
    }
});

app.get('/books', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    res.render('index');
});


app.get('/wishlist', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    const wishlist = req.session.wishlist || [];
    res.render('wishlist', { wishlist });
});


app.post('/add-to-wishlist', (req, res) => {
    const newTitle = req.body.title.trim();
    const newUrl = req.body.url.trim();
    const wishlist = req.session.wishlist || [];

    if (newTitle && newUrl) {
        const titleExists = wishlist.some(book => book.title.toLowerCase() === newTitle.toLowerCase());
        if (!titleExists) {
            wishlist.push({ title: newTitle, url: newUrl });
            req.session.wishlist = wishlist;
        } else {
            console.log(`Title "${newTitle}" is already in the wishlist.`);
        }
    } else {
        console.log('No title provided');
    }
    res.redirect('/wishlist');
});

app.post('/delete-from-wishlist', (req, res) => {
    const index = parseInt(req.body.index, 10);
    const wishlist = req.session.wishlist || []
    if (wishlist.length > index && index >= 0) {
        const removed = wishlist.splice(index, 1);
        req.session.wishlist = wishlist;
    } else {
        console.log('Invalid index for deletion');
    }
    res.redirect('/wishlist');
});

app.get('/wishlist', (req, res) => {
    const wishlist = req.session.wishlist || [];
    res.render('wishlist', { wishlist });
});

app.post('/save-wishlist', async (req, res) => {
    const user = req.session.user;

    if (!user) {
        return res.status(401).send('Unauthorized');
    }

    const wishlist = req.session.wishlist || [];

    try {
        const userRef = db.collection('users').doc(user.uid);
        await userRef.update({ wishlist });
        res.redirect('/wishlist');
    } catch (error) {
        console.error('Error saving wishlist:', error);
        res.status(500).send('Error saving wishlist: ' + error.message);
    }
});

const updateRentedBooksInFirestore = async (user, rentedBooks) => {
    const userRef = db.collection('users').doc(user.uid);
    const totalCost = rentedBooks.reduce((total, book) => total + book.cost, 0);

    await userRef.update({
        rentedBooks,
        totalCost
    });
};

app.post('/rent-book', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    const user = req.session.user;
    req.session.rentedBooks = req.session.rentedBooks || [];
    const rentedBooks = req.session.rentedBooks;

    if (rentedBooks.length >= 3) {
        res.redirect('/rent?error=limit');
    } else {
        const { title, cost } = req.body;
        rentedBooks.push({ title, cost: parseInt(cost) });
        req.session.rentedBooks = rentedBooks;

        try {
            await updateRentedBooksInFirestore(user, rentedBooks);
            res.redirect('/rent');
        } catch (error) {
            console.error('Error updating rented books:', error);
            res.status(500).send('Error updating rented books: ' + error.message);
        }
    }
});

app.post('/save-rented-books', async (req, res) => {
    const user = req.session.user;

    if (!user) {
        return res.status(401).send('Unauthorized');
    }

    try {
        const rentedBooks = req.session.rentedBooks || [];
        await updateRentedBooksInFirestore(user, rentedBooks);
        req.session.rentedBooks = [];
        res.redirect('/rent');
    } catch (error) {
        console.error('Error saving rented books:', error);
        res.status(500).send('Error saving rented books: ' + error.message);
    }
});


app.get('/rent', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    const user = req.session.user;

    try {
        const userRef = db.collection('users').doc(user.uid);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            console.log('No such user!');
            return res.status(404).send('User not found');
        }

        const userData = userDoc.data();
        const rentedBooks = userData.rentedBooks || [];
        const totalCost = userData.totalCost || 0;
        const error = req.query.error === 'limit' ? 'You can only rent up to three books.' : null;

        res.render('rent', { rentedBooks, totalCost, error });
    } catch (error) {
        console.error('Error retrieving rented books:', error);
        res.status(500).send('Error retrieving rented books: ' + error.message);
    }
});

app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/login', async (req, res) => {
    const email = req.body.email;
    const password = req.body.password;

    try {
        const userSnapshot = await db.collection('users').where('email', '==', email).get();
        if (userSnapshot.empty) {
            return res.status(400).send('User not found');
        }
        const userDoc = userSnapshot.docs[0];
        const user = userDoc.data();
        const match = await bcrypt.compare(password, user.password);
        if (match) {
            req.session.user = user;
            req.session.user.uid = userDoc.id;  
            req.session.wishlist = user.wishlist || [];
            res.redirect('/dashboard');
        } else {
            res.status(400).send('Invalid password or user');
        }
    } catch (error) {
        res.status(500).send('Error occurred in login: ' + error.message);
    }
});

app.get('/signup', (req, res) => {
    res.render('signup');
});

app.post('/signup', async (req, res) => {
    const { name, email, password } = req.body;

    try {
        const existing = await db.collection('users').where('email', '==', email).get();
        if (!existing.empty) {
            return res.status(400).send('User already exists');
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.collection('users').add({
            name,
            email,
            password: hashedPassword
        });
        res.redirect('/login');
    } catch (error) {
        res.status(500).send('Error occurred: ' + error.message);
    }
});

app.get('/dashboard', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    res.render('dashboard', { user: req.session.user });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
