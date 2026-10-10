package com.poc.buggy;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
@CrossOrigin(origins = "http://localhost:5173")
public class BugController {

    @GetMapping("/calculate")
    public Object calculate() {
        int x = 100 / 0;
        return x;
    }
}
